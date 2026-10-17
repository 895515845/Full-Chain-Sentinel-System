# syntax=docker/dockerfile:1
FROM node:22-alpine

WORKDIR /app
COPY server.mjs .

ENV PORT=7801
EXPOSE 7801

# /artifacts and /data are mounted by the plugin host. Build the example with:
#   docker build -t ghcr.io/<you>/sentinel-plugin-hello:0.1.0 examples/plugins/hello-world
# then push and copy the digest into plugin.json.
CMD ["node", "server.mjs"]
