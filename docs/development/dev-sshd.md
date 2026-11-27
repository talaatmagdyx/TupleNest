# Local sshd for tunnel tests

The `ssh-core` live tests (`cargo test -p tuplenest-ssh-core -- --ignored`)
need an SSH server on `127.0.0.1:2222` with key auth for the current user.
This runs a fully isolated userland sshd — no Docker, no Remote Login,
no system settings touched.

```sh
D="$HOME/.tuplenest-dev-sshd"
mkdir -p "$D" && chmod 700 "$D" && cd "$D"
ssh-keygen -q -t ed25519 -N "" -f host_ed25519
ssh-keygen -q -t ed25519 -N "" -f client_ed25519
cp client_ed25519.pub authorized_keys
chmod 600 authorized_keys client_ed25519 host_ed25519
cat > sshd_config <<EOF
Port 2222
ListenAddress 127.0.0.1
HostKey $D/host_ed25519
PidFile $D/sshd.pid
AuthorizedKeysFile $D/authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
UsePAM no
StrictModes no
AllowTcpForwarding yes
X11Forwarding no
Subsystem sftp internal-sftp
LogLevel VERBOSE
EOF
/usr/sbin/sshd -f "$D/sshd_config" -E "$D/sshd.log"
```

Stop it with `kill $(cat "$D/sshd.pid")`. The tests read the host key
fingerprint from `host_ed25519.pub` and authenticate with
`client_ed25519`; override the directory with `TUPLENEST_TEST_SSHD_DIR`.
