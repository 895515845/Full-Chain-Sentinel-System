# syntax=docker/dockerfile:1
FROM node:22-alpine

WORKDIR /app
COPY server.mjs .
COPY ui ./ui

ENV PORT=7801
EXPOSE 7801

# /artifacts and /data are mounted by the plugin host. The host builds this
# Dockerfile from the uploaded package; to check it locally:
#   docker build -t sentinel-plugin-hello:0.1.0 examples/plugins/hello-world
CMD ["node", "server.mjs"]
