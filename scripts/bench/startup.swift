// Startup and idle-memory probe for the TupleNest desktop binary.
//
// Usage: swift scripts/bench/startup.swift <binary> <isolated-home> [runs] [idle-seconds]
//
// For each run it:
//   1. snapshots the WebKit XPC processes already running (other apps own them),
//   2. launches <binary> with HOME=<isolated-home>/run-N (an empty data folder),
//   3. records the time until the process owns an on-screen window
//      (CGWindowListCopyWindowInfo, layer 0),
//   4. records the time until the app plus the WebKit processes that appeared
//      after launch go quiet: their combined CPU use stays under 5% of one core
//      for 10 consecutive 50 ms samples (500 ms). The settle time reported is
//      the start of that quiet window, i.e. when the start-up work (Rust setup,
//      WebView launch, JS parse, first render, first IPC round trips) ended,
//   5. on the last run only, idles for [idle-seconds] and prints per-process
//      resident size and physical footprint,
//   6. terminates the app (SIGTERM, then SIGKILL) and waits for its WebKit
//      processes to exit before the next run.
//
// Prints one tab-separated line per run, then a summary.

import AppKit
import CoreGraphics
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

struct Mem { var resident: UInt64; var footprint: UInt64; var cpuNs: Double }

var timebase: Double = {
    var tb = mach_timebase_info_data_t()
    mach_timebase_info(&tb)
    return Double(tb.numer) / Double(tb.denom)
}()

func mem(of pid: pid_t) -> Mem? {
    var info = rusage_info_v4()
    let r = withUnsafeMutablePointer(to: &info) {
        $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) {
            proc_pid_rusage(pid, RUSAGE_INFO_V4, $0)
        }
    }
    return r == 0 ? Mem(
            resident: info.ri_resident_size, footprint: info.ri_phys_footprint,
            cpuNs: Double(info.ri_user_time + info.ri_system_time) * timebase) : nil
}

func hasWindow(_ pid: pid_t) -> Bool {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID)
        as? [[String: Any]]
    else { return false }
    return list.contains {
        ($0[kCGWindowOwnerPID as String] as? Int32) == pid
            && ($0[kCGWindowLayer as String] as? Int) == 0
    }
}

func mb(_ b: UInt64) -> String { String(format: "%.1f", Double(b) / 1_048_576) }

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write(
        "usage: startup.swift <binary> <isolated-home> [runs] [idle-seconds]\n".data(using: .utf8)!)
    exit(2)
}
let binary = args[1]
let homeRoot = args[2]
let runs = args.count > 3 ? Int(args[3])! : 7
let idleSeconds = args.count > 4 ? Double(args[4])! : 30

var windowTimes: [Double] = []
var settleTimes: [Double] = []
print("run\twindow_ms\tsettled_ms\tresident_mb_at_settle")

for run in 1...runs {
    let home = "\(homeRoot)/run-\(run)"
    try? FileManager.default.removeItem(atPath: home)
    try! FileManager.default.createDirectory(atPath: home, withIntermediateDirectories: true)

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

    var tWindow: Double? = nil
    var tSettled: Double? = nil
    var settledRss: UInt64 = 0
    var children: Set<pid_t> = []
    // CPU time per process at the previous sample; a process seen for the
    // first time contributes nothing until its second sample.
    var lastCpu: [pid_t: Double] = [:]
    var lastT = now()
    var quiet = 0
    var quietStart = 0.0
    let deadline = t0 + 30
    while now() < deadline && (tWindow == nil || tSettled == nil) {
        if tWindow == nil && hasWindow(pid) { tWindow = now() - t0 }
        children = webkitPids().subtracting(before)
        let t = now()
        var busyNs = 0.0
        var total: UInt64 = 0
        for q in [pid] + Array(children) {
            guard let m = mem(of: q) else { continue }
            total += m.resident
            if let prev = lastCpu[q] { busyNs += m.cpuNs - prev }
            lastCpu[q] = m.cpuNs
        }
        let load = busyNs / ((t - lastT) * 1e9)
        lastT = t
        if tWindow != nil && !children.isEmpty && load < 0.05 {
            if quiet == 0 { quietStart = t - t0; settledRss = total }
            quiet += 1
            if quiet >= 10 { tSettled = quietStart }
        } else {
            quiet = 0
        }
        usleep(50_000)
    }
    let w = tWindow.map { $0 * 1000 } ?? .nan
    let s = tSettled.map { $0 * 1000 } ?? .nan
    windowTimes.append(w)
    settleTimes.append(s)
    print("\(run)\t\(String(format: "%.0f", w))\t\(String(format: "%.0f", s))\t\(mb(settledRss))")

    if run == runs {
        Thread.sleep(forTimeInterval: idleSeconds)
        children = webkitPids().subtracting(before)
        print("\nidle after \(Int(idleSeconds)) s (last run):")
        print("process\tresident_mb\tfootprint_mb")
        var tr: UInt64 = 0, tf: UInt64 = 0
        for q in [pid] + children.sorted() {
            guard let m = mem(of: q) else { continue }
            let name = (path(of: q) as NSString).lastPathComponent
            print("\(name)\t\(mb(m.resident))\t\(mb(m.footprint))")
            tr += m.resident
            tf += m.footprint
        }
        print("total\t\(mb(tr))\t\(mb(tf))")
    }

    kill(pid, SIGTERM)
    let killBy = now() + 5
    while p.isRunning && now() < killBy { usleep(50_000) }
    if p.isRunning { kill(pid, SIGKILL) }
    p.waitUntilExit()
    // Let its WebKit processes go before the next launch is measured.
    let goneBy = now() + 10
    while !webkitPids().subtracting(before).isEmpty && now() < goneBy { usleep(100_000) }
    usleep(500_000)
}

func summary(_ name: String, _ xs: [Double]) {
    let v = xs.filter { !$0.isNaN }.sorted()
    guard !v.isEmpty else { print("\(name): no data"); return }
    let med = v.count % 2 == 1 ? v[v.count / 2] : (v[v.count / 2 - 1] + v[v.count / 2]) / 2
    // Nearest-rank p95; equals the maximum below 20 samples.
    let p95 = v[min(v.count, Int((0.95 * Double(v.count)).rounded(.up))) - 1]
    print(String(format: "%@: median %.0f ms, p95 %.0f, min %.0f, max %.0f (n=%d)",
                 name, med, p95, v.first!, v.last!, v.count))
}
print("")
summary("window on screen", windowTimes)
summary("start-up work settled (CPU quiet)", settleTimes)
