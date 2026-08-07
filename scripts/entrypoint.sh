#!/bin/sh
# Container entrypoint.
#
# A headed browser needs a display, and a container has none. The obvious fix is
# to wrap the server in `xvfb-run`, and that is what was tried first: the
# container started, migrations ran, and then nothing — no boot banner, no
# listener, a failed healthcheck and no error anywhere explaining it. xvfb-run
# spawns its own process tree and the server's stdout never came back.
#
# So the display is started as a plain background process and the server is
# exec'd directly. `exec` matters: node becomes PID 1, keeps its stdout, and
# receives SIGTERM on shutdown instead of being orphaned behind a wrapper.
set -e

Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp >/dev/null 2>&1 &

# Give X a moment to create its socket; a browser launched before it exists
# fails with "Target page, context or browser has been closed", which names
# neither the display nor the race.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -e /tmp/.X11-unix/X99 ] && break
  sleep 0.3
done

export DISPLAY=:99
echo "[entrypoint] DISPLAY=$DISPLAY ($( [ -e /tmp/.X11-unix/X99 ] && echo 'X ready' || echo 'X NOT ready — headed browsers will fail' ))"

exec node dist/src/server.js
