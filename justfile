# List available recipes.
default:
    @just --list

# Install dependencies from the lockfile.
install:
    npm ci

# Bundle main.js and its dependencies into dist/index.js.
build:
    npm run build

# Run the test suite.
test:
    npm test

# Check formatting without writing changes.
fmt-check:
    npx prettier --check .

# Reformat the tree in place.
fmt:
    npx prettier --write .

# Verify dist/index.js matches a fresh build, the way CI does.
check-dist: build
    git diff --exit-code dist/index.js

# Everything CI runs, in the same order.
ci: fmt-check test check-dist

# Remove build output and installed dependencies.
clean:
    rm -rf node_modules dist/index.js
