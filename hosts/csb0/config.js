window.HOSTDASH_CONFIG = {
  slug: "csb0",
  storageKey: "hostdash.csb0",
  host: {
    name: "csb0",
    role: "cloud smart home",
    os: "NixOS",
    fqdn: "cs0.barta.cm",
    ip: "89.58.63.96",
    title: "csb0 · cloud smart home",
    heading: "Services",
  },
  meta: [
    { text: "hosts/csb0/docker", code: true },
    { text: "csb0", code: true },
    "Europe/Vienna",
  ],
  wings: [
    { id: "edge", name: "Edge & Access", color: "var(--home)", icon: "radio-tower" },
    { id: "smart", name: "Smart Home", color: "var(--media)", icon: "workflow" },
    { id: "ops", name: "Ops & Fleet", color: "var(--signals)", icon: "radar" },
    { id: "housekeeping", name: "Housekeeping", color: "var(--infra)", icon: "refresh-cw" },
  ],
  services: [
    { wing: "edge", name: "Traefik API", purpose: "Public TLS edge and Docker router", icon: "shield-alert", url: "https://cs0.barta.cm/api/version", port: ":443 /api" },
    { wing: "edge", name: "Headscale", purpose: "Tailnet control plane", icon: "radio-tower", url: "https://hs.barta.cm/", port: ":443" },
    { wing: "edge", name: "Tesla Fleet Key", purpose: "Tesla Fleet API domain-verification key host", icon: "key-round", url: "https://ev.barta.cm/.well-known/appspecific/com.tesla.3p.public-key.pem", port: ":443" },
    { wing: "edge", name: "docker socket proxy", purpose: "Read-only Docker API for Traefik discovery", icon: "server", passive: true, foot: "internal · :2375" },

    { wing: "smart", name: "Node-RED", purpose: "Cloud automation flows and Telegram hooks", icon: "logo-nodered", url: "https://home.barta.cm/", port: ":443" },
    { wing: "smart", name: "Mosquitto", purpose: "MQTT broker for smart-home telemetry", icon: "logo-mqtt", passive: true, foot: ":8883 tls · :1883 internal" },

    { wing: "ops", name: "Uptime Kuma", purpose: "Cloud and public service uptime checks", icon: "bell-ring", url: "https://uptime.barta.cm/", port: ":443" },
    { wing: "ops", name: "FleetCom Bosun", purpose: "Heartbeats and lifecycle events to fleet.barta.cm", icon: "satellite-dish", passive: true, foot: "agent · outbound only" },
    { wing: "ops", name: "pharos-beacon", purpose: "Host status to pharosd on csb1", icon: "radar", passive: true, foot: "beacon · outbound only" },

    { wing: "housekeeping", name: "restic", purpose: "Nightly backup to Hetzner Storage Box", icon: "hard-drive-download", passive: true, foot: "01:30 daily · backup" },
    { wing: "housekeeping", name: "SMTP relay", purpose: "Outbound container mail through Hover", icon: "mail", passive: true, foot: ":25 internal · relay" },
    { wing: "housekeeping", name: "Watchtower", purpose: "Weekly updates for opted-in containers", icon: "refresh-cw", passive: true, foot: "Sat 08:00 · scheduled" },
  ],
};
