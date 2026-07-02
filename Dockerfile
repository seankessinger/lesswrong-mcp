# Deploys lesswrong_mcp as a remote Streamable-HTTP MCP server.
# The MCP endpoint is served at /mcp on the container's port.
FROM python:3.12-slim

# Run as an unprivileged user: the server only needs outbound HTTPS and one bound
# port, so it never needs root. Keeps blast radius small if a dependency is ever
# compromised by a crafted forum response.
RUN useradd --system --create-home --uid 10001 app

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY lesswrong_mcp/ ./lesswrong_mcp/

# HTTP transport, bound to all interfaces. The app binds $PORT if the platform
# injects one, else MCP_PORT (8000). Manufact/most PaaS set $PORT automatically.
ENV MCP_TRANSPORT=http \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=8000 \
    PYTHONUNBUFFERED=1

USER app

EXPOSE 8000

# Liveness probe against the built-in /health route (honours $PORT / MCP_PORT).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import os,urllib.request,sys; p=os.environ.get('PORT') or os.environ.get('MCP_PORT') or '8000'; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:'+p+'/health', timeout=4).status==200 else 1)"

CMD ["python", "-m", "lesswrong_mcp"]
