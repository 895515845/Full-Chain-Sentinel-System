# syntax=docker/dockerfile:1
# subfinder is a static Go binary, so it can be copied out of its official image.
# naabu is copied the same way and its base image already carries libpcap.
FROM projectdiscovery/subfinder:latest AS subfinder
FROM projectdiscovery/naabu:latest

COPY --from=subfinder /usr/local/bin/subfinder /usr/local/bin/subfinder
RUN apk add --no-cache python3

WORKDIR /app
COPY server.py .

ENV PORT=7801
EXPOSE 7801

CMD ["python3", "server.py"]
