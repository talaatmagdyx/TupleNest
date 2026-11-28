// Idle soak probe for the TupleNest desktop binary.
//
// Usage: soak.swift <binary> <isolated-home> <duration-s> <interval-s> <out.csv>
//
// Launches <binary> once with HOME=<isolated-home> (an empty data folder),
// then every <interval-s> seconds, for <duration-s> seconds, writes one CSV row
// with, for the app process and for the WebKit processes that appeared after
// launch (summed):
//   - physical footprint and resident size (proc_pid_rusage),
//   - open file handles: the number of lines `lsof -p <pid>` prints, minus its
//     header (so it includes the executable, mapped libraries, the cwd and
//     sockets, not only file descriptors),
//   - the 1-minute load average.
// At the end it terminates the app (SIGTERM, then SIGKILL).
//
// Nothing drives the app: no connection is opened and no query is run. This
// measures the app sitting on its first-run screen, which is where a timer,
// a polling loop or a leak in the always-on parts would show.

import Darwin
import Foundation

func now() -> Double {
    var ts = timespec()
    clock_gettime(CLOCK_MONOTONIC_RAW, &ts)
    return Double(ts.tv_sec) + Double(ts.tv_nsec) / 1e9
}

func allPids() -> [pid_t] {
    let n = proc_listallpids(nil, 0)
    var buf = [pid_t](repeating: 0, count: Int(n) * 2)
    let got = proc_listallpids(&buf, Int32(buf.count * MemoryLayout<pid_t>.size))
    return Array(buf.prefix(Int(got))).filter { $0 > 0 }
}

func path(of pid: pid_t) -> String {
    var buf = [CChar](repeating: 0, count: 4096)
    let r = proc_pidpath(pid, &buf, UInt32(buf.count))
    return r > 0 ? String(cString: buf) : ""
}

func webkitPids() -> Set<pid_t> {
    Set(allPids().filter { path(of: $0).contains("/WebKit.framework/") })
}

func mem(of pid: pid_t) -> (resident: UInt64, footprint: UInt64)? {
    var info = rusage_info_v4()
    let r = withUnsafeMutablePointer(to: &info) {
        $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) {
            proc_pid_rusage(pid, RUSAGE_INFO_V4, $0)
        }
    }
    return r == 0 ? (info.ri_resident_size, info.ri_phys_footprint) : nil
}

func lsofCount(_ pid: pid_t) -> Int {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
    p.arguments = ["-n", "-P", "-p", "\(pid)"]
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    guard (try? p.run()) != nil else { return -1 }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    let lines = String(decoding: data, as: UTF8.self).split(separator: "\n").count
    return max(0, lines - 1)
}

func load1() -> Double {
    var l = [Double](repeating: 0, count: 3)
    return getloadavg(&l, 3) > 0 ? l[0] : .nan
}

func mb(_ b: UInt64) -> String { String(format: "%.1f", Double(b) / 1_048_576) }

let args = CommandLine.arguments
guard args.count == 6, let duration = Double(args[3]), let interval = Double(args[4]) else {
    FileHandle.standardError.write(
        "usage: soak.swift <binary> <isolated-home> <duration-s> <interval-s> <out.csv>\n"
            .data(using: .utf8)!)
    exit(2)
}
let binary = args[1]
let home = args[2]
let csvPath = args[5]
try! FileManager.default.createDirectory(atPath: home, withIntermediateDirectories: true)
FileManager.default.createFile(atPath: csvPath, contents: nil)
let csv = FileHandle(forWritingAtPath: csvPath)!
func row(_ s: String) {
    csv.write((s + "\n").data(using: .utf8)!)
    print(s)
    fflush(stdout)
}

let before = webkitPids()
let p = Process()
p.executableURL = URL(fileURLWithPath: binary)
var env = ProcessInfo.processInfo.environment
env["HOME"] = home
p.environment = env
p.standardOutput = FileHandle.nullDevice
p.standardError = FileHandle.nullDevice
let t0 = now()
try! p.run()
let pid = p.processIdentifier

row("elapsed_s,app_footprint_mb,app_resident_mb,webkit_footprint_mb,webkit_resident_mb,"
    + "total_footprint_mb,app_handles,webkit_handles,webkit_processes,load1")
var next = t0
while now() - t0 <= duration {
    guard p.isRunning else {
        FileHandle.standardError.write("app exited early\n".data(using: .utf8)!)
        exit(1)
    }
    let children = webkitPids().subtracting(before)
    let app = mem(of: pid) ?? (0, 0)
    var wr: UInt64 = 0, wf: UInt64 = 0, wh = 0
    for c in children {
        if let m = mem(of: c) { wr += m.resident; wf += m.footprint }
        wh += lsofCount(c)
    }
    row([
        String(format: "%.0f", now() - t0), mb(app.footprint), mb(app.resident), mb(wf), mb(wr),
        mb(app.footprint + wf), "\(lsofCount(pid))", "\(wh)", "\(children.count)",
        String(format: "%.2f", load1()),
    ].joined(separator: ","))
    next += interval
    let wait = next - now()
    if wait > 0 { usleep(UInt32(wait * 1e6)) }
}

kill(pid, SIGTERM)
let killBy = now() + 5
while p.isRunning && now() < killBy { usleep(50_000) }
if p.isRunning { kill(pid, SIGKILL) }
p.waitUntilExit()
