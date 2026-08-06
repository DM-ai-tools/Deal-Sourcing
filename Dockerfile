# Playwright's own image, because the browser and its ~90 system libraries are
# already present and correct. Installing Chromium onto a plain node image is
# possible and is a reliable source of deploys that build green and then fail
# at the first page load with a missing shared object.
FROM mcr.microsoft.com/playwright:v1.50.1-jammy

WORKDIR /app

# NODE_ENV is deliberately NOT production yet.
#
# The build needs TypeScript and the Prisma CLI, and both are devDependencies.
# An earlier version set NODE_ENV=production here and then ran
# `npm ci --omit=dev && npx prisma generate`, which cannot work: the CLI it
# calls was just omitted. Production is set after the build instead.
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --ignore-scripts

COPY . .

# Generate before compiling — tsc type-checks code that imports the client, so
# the client has to exist first.
RUN npx prisma generate && npm run build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/src/server.js"]
