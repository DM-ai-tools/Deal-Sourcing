# Playwright's own image, because the ~90 system libraries a browser needs are
# already present and correct. Installing them onto a plain node image is
# possible and is a reliable source of deploys that build green and then fail at
# the first page load with a missing shared object.
#
# The tag tracks the installed client version. An earlier revision pinned
# v1.50.1 while npm had resolved 1.62.1, which fails at browser launch —
# Playwright requires browser builds matching its own version exactly. Keep this
# tag and package.json in step.
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app

# NODE_ENV is deliberately NOT production yet.
#
# The build needs TypeScript and the Prisma CLI, and both are devDependencies.
# An earlier version set it here and then ran `npm ci --omit=dev && npx prisma
# generate`, which cannot work: the CLI it calls was just omitted.
COPY package*.json ./
COPY prisma ./prisma

# Native modules are built here on purpose. camoufox-js pulls in better-sqlite3,
# which needs a toolchain — absent on the Windows dev machine, present in this
# image. Camoufox is therefore an optional layer locally and a real one in
# production, and the transport lazy-imports it so a missing build degrades to a
# readable message rather than taking down the process.
RUN npm ci

COPY . .

# Real Google Chrome, not the bundled Chromium: patchright's recommended
# configuration uses `channel: 'chrome'`, and the base image ships Chromium
# only. The two are not interchangeable for fingerprinting purposes — a genuine
# Chrome binary emits genuine Chrome TLS, which is one of the layers Akamai
# checks before any JavaScript runs.
RUN npx patchright install --with-deps chrome

# Camoufox downloads its own Firefox build. Non-fatal: it is a fallback layer,
# and a deploy should not die because an optional transport could not fetch its
# browser. The transport reports the absence clearly if it is ever selected.
RUN npx camoufox-js fetch || echo "[build] camoufox browser not fetched — that transport will report it"

RUN npx prisma generate && npm run build

ENV NODE_ENV=production
EXPOSE 3000

# xvfb-run because the recommended browser configuration is headed and a
# container has no display. Headless is itself a detection signal, so this is
# not a workaround to be optimised away later.
CMD ["xvfb-run", "-a", "node", "dist/src/server.js"]
