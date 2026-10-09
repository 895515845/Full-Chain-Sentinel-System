# ZGAgent pentest toolbox image.
# Build: docker build -t zgagent:latest docker/
#
# Base is Kali rolling; pinned tool groups are installed with apt. The
# "extended" layer installs packages whose availability varies across Kali
# releases and is allowed to fail without breaking the build.

FROM kalilinux/kali-rolling:latest

ARG DEBIAN_FRONTEND=noninteractive
# Container runtime may inject a host proxy that apt cannot use (socks5); clear it.
ENV http_proxy= https_proxy= all_proxy= HTTP_PROXY= HTTPS_PROXY= ALL_PROXY=

# Core toolchain: recon/enumeration, web exploitation, brute force / intranet.
RUN apt-get update && apt-get install -y --no-install-recommends \
		# recon & enumeration
		nmap \
		masscan \
		dnsrecon \
		whatweb \
		subfinder \
		enum4linux \
		# web exploitation
		ffuf \
		dirsearch \
		wafw00f \
		testssl.sh \
		sqlmap \
		# brute force / intranet movement
		hashcat \
		john \
		hydra \
		netexec \
		impacket-scripts \
		# fundamentals
		curl \
		wget \
		whois \
		netcat-traditional \
		socat \
		openssh-client \
		proxychains4 \
		git \
		jq \
		python3 \
		python3-pip \
		ripgrep \
		fd-find \
		zip \
		unzip \
	&& rm -rf /var/lib/apt/lists/*

# Extended tools: availability varies by Kali release; failures are tolerated.
RUN apt-get update && apt-get install -y --no-install-recommends \
		responder \
		chisel \
	|| echo "[zgagent] extended tools partially unavailable (ok)" \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /work

# Long-running idle entrypoint; ZGAgent drives it with docker exec.
CMD ["sleep", "infinity"]
