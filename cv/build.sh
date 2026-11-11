#!/bin/sh
# Rebuild assets/cv.pdf from cv/cv.html with headless Chrome.
# Usage: sh cv/build.sh   (from anywhere; needs network access for the Google Fonts)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out="$here/../assets/cv.pdf"
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

"$chrome" --headless=new --disable-gpu --no-pdf-header-footer \
  --virtual-time-budget=15000 --run-all-compositor-stages-before-draw \
  --print-to-pdf="$out" "file://$here/cv.html" 2>/dev/null

echo "Wrote $out"
