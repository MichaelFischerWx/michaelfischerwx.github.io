#!/bin/sh
# Rebuild assets/cv.pdf from cv/cv.html with headless Chrome.
# Usage: sh cv/build.sh   (from anywhere; needs network access for the Google Fonts)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out="$here/../assets/cv.pdf"
tmp="$here/.cv-build.pdf"
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

rm -f "$tmp"
# Headless Chrome often exits non-zero ("Teardown watchdog expired") after the PDF is
# already written, so judge success by the output file, not the exit code.
"$chrome" --headless=new --disable-gpu --no-pdf-header-footer \
  --virtual-time-budget=15000 --run-all-compositor-stages-before-draw \
  --print-to-pdf="$tmp" "file://$here/cv.html" >/dev/null 2>&1 || true

if [ ! -s "$tmp" ]; then
  echo "Chrome did not write a PDF" >&2
  exit 1
fi
mv "$tmp" "$out"
echo "Wrote $out"
