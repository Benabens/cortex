#!/usr/bin/env bash
# OCR hors ligne dans l'image (lib/ocr) : les langues de tesseract sont là, et il lit une page
# d'anglais et une page de français rendues à 300 dpi par pdftoppm, comme l'ingestion.
# Lancé par la CI, réseau coupé : docker run -i --network none --entrypoint bash cortex-app -s < .ci/ocr-smoke.sh
set -euo pipefail
langs=$(tesseract --list-langs 2>/dev/null)
for l in eng fra deu ita spa osd; do
  echo "$langs" | grep -qx "$l" || { echo "::error::langue tesseract absente : $l"; exit 1; }
done
mkdir -p /tmp/ocr && cd /tmp/ocr
# Même document que le préchauffage du Dockerfile (logo compris : sans lui, le repli texte du logo
# demande une police absente du cache hors ligne) ; seul le texte change.
cp /app/cortex/latex/epfl-logo.png . 2>/dev/null || true
page() { # page <nom> <phrase>
  cat /app/cortex/latex/preamble.tex /app/cortex/latex/figures.tex /app/cortex/latex/generic.tex > "$1.tex"
  printf '\n\\usepackage{multicol}\n\\newcommand{\\FOOTDATE}{Smoke}\n\\begin{document}\n%s\n\\end{document}\n' "$2" >> "$1.tex"
  /usr/local/bin/tectonic --chatter minimal --only-cached "$1.tex"
  pdftoppm -gray -r 300 -f 1 -l 1 -singlefile "$1.pdf" "$1"
}
page en "Compute the decay rate of the amplitude of the damped wave."
page fr "Calculer le taux de décroissance de l'amplitude de l'onde amortie."
start=$(date +%s%N)
OMP_THREAD_LIMIT=1 tesseract en.pgm stdout -l eng 2>/dev/null > en.txt
end=$(date +%s%N)
OMP_THREAD_LIMIT=1 tesseract fr.pgm stdout -l fra 2>/dev/null > fr.txt
cat en.txt fr.txt
grep -q "decay rate" en.txt || { echo "::error::tesseract ne lit pas l'anglais"; exit 1; }
grep -q "décroissance" fr.txt || { echo "::error::tesseract ne lit pas le français"; exit 1; }
echo "✓ OCR hors ligne (eng, fra) en $(id -un) ; une page A4 à 300 dpi, un fil : $(( (end - start) / 1000000 )) ms"
