#!/bin/sh
# Run TLC on one model/config: specs/tla/run.sh <Module> <Config>
# Needs Java and tla2tools.jar: set JAVA and TLA2TOOLS, or put them on PATH / next to this script.
cd "$(dirname "$0")"
JAVA=${JAVA:-java}
TLA2TOOLS=${TLA2TOOLS:-tla2tools.jar}
exec "$JAVA" -XX:+UseParallelGC -cp "$TLA2TOOLS" tlc2.TLC -workers auto -deadlock -config "$2.cfg" -metadir "${TMPDIR:-/tmp}/tlc-$2" "$1.tla"
