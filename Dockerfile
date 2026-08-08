FROM node:24-alpine

WORKDIR /app

# The build context contains only the already verified npm candidate. The
# container never recompiles or copies repository-local runtime assets.
COPY --chown=node:node .cache/distribution/digital-employee-package.tgz ./digital-employee-package.tgz
RUN npm init --yes >/dev/null \
  && npm install --omit=dev --ignore-scripts --no-audit --no-fund ./digital-employee-package.tgz \
  && rm ./digital-employee-package.tgz

USER node

ENTRYPOINT ["node", "./node_modules/@fullstack-ai-infra/digital-employee/dist/apps/cli/bin.js"]
CMD ["--help"]
