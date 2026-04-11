rsync -avz \
  --filter=":- .gitignore" \
  --exclude=".git/" \
  --exclude="node_modules/" \
  --exclude=".expo/" \
  --exclude="dist/" \
  --exclude="web-build/" \
  --exclude="android/" \
  --exclude="ios/" \
  --exclude=".kotlin/" \
  --exclude="test-results/" \
  --exclude=".claude/*.lock" \
  --exclude=".claude/settings.local.json" \
  --exclude=".environments/" \
  --exclude=".DS_Store" \
  --exclude="*.tsbuildinfo" \
  --del \
  ./ qc-sgp:/root/happy/
