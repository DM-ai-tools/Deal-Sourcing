# Playwright's own image, because the browser and its ~90 system libraries are
# already present and correct. Installing Chromium onto a plain node image is
# possible and is a reliable source of deploys that build green and then fail
# at the first page load with a missing shared object.
FROM mcr.microsoft.com/playwright:v1.50.1-jammy

WORKDIR /app
ENV NODE_ENV=production

# Dependencies first, so a code change does not invalidate the install layer.
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev --ignore-scripts && npx prisma generate

COPY . .

# devDependencies are needed to compile, then discarded.
RUN npm ci --ignore-scripts \
 && npx prisma generate \
 && npm run build \
 && npm prune --omit=dev

EXPOSE 3000
CMD ["node", "dist/src/server.js"]
