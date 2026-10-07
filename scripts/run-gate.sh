#!/bin/sh
# One-shot e2e gate runner: ensures the lobby relay (:8940) and the
# production server (:3210) are alive, then runs the online-touch gate.
# Everything happens inside THIS shell invocation so the sandbox cannot
# recycle the background processes between tool calls.
set -e
cd /home/z/my-project/FightingGameEngine-Web
export PATH="$HOME/.deno/bin:$PATH"

if ! curl -s -o /dev/null --max-time 2 http://127.0.0.1:8940/ ; then
  echo "[gate-runner] starting relay :8940"
  setsid nohup "$HOME/.deno/bin/deno" run --allow-net --allow-env netrelay/relay.ts \
    > /home/z/my-project/scripts/relay.log 2>&1 < /dev/null &
  sleep 2
fi

if ! curl -s -o /dev/null --max-time 2 http://127.0.0.1:3210/game/webrtc.js ; then
  echo "[gate-runner] starting production server :3210"
  setsid nohup npx next start -p 3210 \
    > /home/z/my-project/scripts/next-3210.log 2>&1 < /dev/null &
  i=0
  while [ $i -lt 30 ]; do
    if curl -s -o /dev/null --max-time 2 http://127.0.0.1:3210/game/webrtc.js ; then break; fi
    sleep 1; i=$((i+1))
  done
fi

curl -s -o /dev/null --max-time 2 http://127.0.0.1:8940/ && echo "[gate-runner] relay OK" || echo "[gate-runner] relay DOWN"
curl -s -o /dev/null --max-time 2 http://127.0.0.1:3210/game/webrtc.js && echo "[gate-runner] server OK" || echo "[gate-runner] server DOWN"
exec node scripts/online-touch-test/run.mjs --base http://127.0.0.1:3210 "$@"
