# Custom Caddy build with the Cloudflare DNS plugin, so we can issue publicly
# trusted Let's Encrypt certs via DNS-01 even while behind Cloudflare's proxy
# (orange cloud). Until the registrar nameservers point to Cloudflare we run
# with `tls internal`; flip CADDY_TLS to use the plugin afterwards.
# NOTE: caddy:2.8-builder fails to compile against newer Go
# (undefined: zapslog.HandlerOptions). Use 2.10+ which builds cleanly.
FROM caddy:2.10-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/cloudflare

FROM caddy:2.10-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
