# Build environment for Anthropic OSS Scanner.
# The scanner builds this file with the repository as the build context, then audits the image without
# network access. Everything the build and the tests need is fetched here.
FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    CI=true \
    PNPM_HOME=/usr/local/share/pnpm \
    NODE_OPTIONS=--enable-source-maps
ENV PATH=$PNPM_HOME:$PATH

# git is used by the evidence collector (git diff, changed paths) and by the tests.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

# The version must match "packageManager" in package.json.
RUN npm install --global pnpm@11.9.0 && pnpm --version

# scanner contract: the checkout lives inside the image, at /src
COPY . /src
WORKDIR /src

# Tests create temporary Git repositories and commit in them.
RUN git config --global user.name "NotDone Scanner" \
    && git config --global user.email "scanner@localhost" \
    && git config --global init.defaultBranch main \
    && git config --global --add safe.directory '*'

# Install every dependency while the network is available, then build all packages.
RUN pnpm install --frozen-lockfile && pnpm build

# Run the checks once so the image is known to work offline. A failing test does not abort the build.
RUN (pnpm typecheck && pnpm test && pnpm test:plugins && pnpm test:conformance) \
    || echo "WARNING: NotDone tests reported failures"
