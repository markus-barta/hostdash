window.HOSTDASH_CONFIG = {
  slug: "csb1",
  storageKey: "hostdash.csb1",
  host: {
    name: "csb1",
    role: "cloud apps",
    os: "NixOS",
    fqdn: "cs1.barta.cm",
    ip: "152.53.64.166",
    title: "csb1 · cloud apps",
    heading: "Services",
  },
  meta: [
    { text: "hosts/csb1/docker", code: true },
    { text: "csb1", code: true },
    "Europe/Vienna",
  ],
  wings: [
    { id: "edge", name: "Edge & Identity", color: "var(--home)", icon: "shield-alert" },
    { id: "docs", name: "Docs & Work", color: "var(--media)", icon: "book-open" },
    { id: "platforms", name: "Platforms", color: "var(--signals)", icon: "server" },
    { id: "sites", name: "Sites", color: "var(--safety)", icon: "globe" },
    { id: "data", name: "Data & Sidecars", color: "var(--infra)", icon: "database" },
    { id: "housekeeping", name: "Housekeeping", color: "var(--soft)", icon: "refresh-cw" },
  ],
  services: [
    { wing: "edge", name: "Traefik API", container: "csb1-traefik-1", purpose: "Public TLS edge and Docker router", icon: "shield-alert", url: "https://cs1.barta.cm/api/version", port: ":443 /api" },
    { wing: "edge", name: "Zitadel", container: "zitadel", purpose: "INSPR identity provider", icon: "key-round", url: "https://auth.inspr.at/", port: ":443" },
    { wing: "edge", name: "inspr-auth", container: "inspr-auth", purpose: "Magic-link and session gateway for inspr.at", icon: "shield-alert", url: "https://inspr.at/enter", port: ":443" },
    { wing: "edge", name: "docker socket proxy", container: "csb1-docker-proxy-traefik-1", purpose: "Read-only Docker API for Traefik discovery", icon: "server", passive: true, foot: "internal · :2375" },

    { wing: "docs", name: "Docmost", container: "csb1-docmost-1", purpose: "Team knowledge base", icon: "book-open", url: "https://docmost.barta.cm/", port: ":443" },
    { wing: "docs", name: "Paperless", container: "csb1-paperless-1", purpose: "Document archive and OCR", icon: "file-text", url: "https://paperless.barta.cm/", port: ":443" },
    { wing: "docs", name: "Excalidraw", container: "csb1-excalidraw-1", purpose: "Self-hosted whiteboard", icon: "pen-tool", url: "https://draw.barta.cm/", port: ":443" },
    { wing: "docs", name: "PPM", container: "ppm", purpose: "Personal project management", icon: "logo-paimos", url: "https://pm.barta.cm/", port: ":443" },

    { wing: "platforms", name: "Janus", container: "janus", purpose: "Secret metadata control plane", icon: "key-round", url: "https://vault.barta.cm/", port: ":443", status: "protected", note: "SSO/CORP-protected; browser probes from HostDash are intentionally disabled" },
    { wing: "platforms", name: "MinIO", container: "minio", purpose: "Object storage console for app attachments", icon: "box", url: "https://minio.barta.cm/", port: ":443" },
    { wing: "platforms", name: "Pharos", container: "pharosd", purpose: "Fleet status dashboard and beacon receiver", icon: "radar", url: "https://pharos.barta.cm/", port: ":443" },
    { wing: "platforms", name: "WEG Portal", container: "hausv-org", purpose: "Multi-tenant house portal", icon: "house", url: "https://jhw22.hausv.org/", port: ":443" },

    { wing: "sites", name: "INSPR site", container: "inspr-www", purpose: "Public INSPR web presence", icon: "globe", url: "https://inspr.at/", port: ":443", status: "external", note: "Public site sends CORP same-origin; browser probes from HostDash are intentionally disabled" },
    { wing: "sites", name: "PAIMOS site", container: "paimos-www", purpose: "Public PAIMOS web presence", icon: "logo-paimos", url: "https://paimos.com/", port: ":443" },
    { wing: "sites", name: "jobs.at", container: "csb1-jobs-at-1", purpose: "Austrian labor-market exposition", icon: "briefcase", url: "https://zukunftschance.ai.barta.cm/", port: ":443" },

    { wing: "data", name: "Docmost Postgres", container: "csb1-docmost-db-1", purpose: "Docmost relational store", icon: "database", passive: true, foot: "postgres · internal" },
    { wing: "data", name: "Docmost Redis", container: "csb1-docmost-redis-1", purpose: "Docmost cache and jobs", icon: "database", passive: true, foot: "redis · internal" },
    { wing: "data", name: "Paperless Postgres", container: "csb1-paperless-db-1", purpose: "Paperless relational store", icon: "database", passive: true, foot: "postgres · internal" },
    { wing: "data", name: "Paperless Redis", container: "csb1-paperless-redis-1", purpose: "Paperless cache and task queue", icon: "database", passive: true, foot: "redis · internal" },
    { wing: "data", name: "Paperless Tika", container: "csb1-paperless-tika-1", purpose: "Document text extraction sidecar", icon: "file-text", passive: true, foot: ":9998 internal" },
    { wing: "data", name: "Paperless Gotenberg", container: "csb1-paperless-gotenberg-1", purpose: "Office/PDF conversion sidecar", icon: "file-text", passive: true, foot: ":3000 internal" },
    { wing: "data", name: "Zitadel Postgres", container: "zitadel-postgres", purpose: "Zitadel identity database", icon: "database", passive: true, foot: "postgres · internal" },

    { wing: "housekeeping", name: "restic", container: "csb1-restic-cron-hetzner-1", purpose: "Nightly backup to Hetzner Storage Box", icon: "hard-drive-download", passive: true, foot: "01:30 daily · backup" },
    { wing: "housekeeping", name: "SMTP relay", container: "csb1-smtp-1", purpose: "Outbound container mail", icon: "mail", passive: true, foot: ":25 internal · relay" },
    { wing: "housekeeping", name: "Container updates", unit: "compose-csb1-update.timer", purpose: "Weekly updates for the compose stack", icon: "refresh-cw", passive: true, foot: "Sat 08:00 · scheduled" },
    { wing: "housekeeping", name: "pharos-beacon", container: "pharos-beacon", purpose: "Host status to local pharosd", icon: "radar", passive: true, foot: "beacon · outbound only" },
  ],
};
