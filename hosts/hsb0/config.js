window.HOSTDASH_CONFIG = {
  slug: "hsb0",
  storageKey: "hostdash.hsb0",
  host: {
    name: "hsb0",
    role: "network core",
    os: "NixOS",
    fqdn: "hsb0.lan",
    ip: "192.168.1.99",
    title: "hsb0 · network core",
    heading: "Services",
  },
  meta: [
    { text: "hosts/hsb0/docker", code: true },
    { text: "hsb0-home", code: true },
    "Europe/Vienna",
  ],
  wings: [
    { id: "network", name: "DNS & Cache", color: "var(--home)", icon: "radio-tower" },
    { id: "agents", name: "Agents & Fleet", color: "var(--media)", icon: "radar" },
    { id: "telemetry", name: "Telemetry", color: "var(--signals)", icon: "satellite-dish" },
    { id: "housekeeping", name: "Housekeeping", color: "var(--infra)", icon: "refresh-cw" },
  ],
  services: [
    { wing: "network", name: "AdGuard Home", unit: "adguardhome.service", purpose: "LAN DNS, DHCP, filtering, and rewrites", icon: "logo-adguard", url: "http://hsb0.lan:3000/", sameHost: true, port: ":3000" },
    { wing: "network", name: "NCPS", container: "ncps", purpose: "Nix binary cache proxy for the LAN fleet", icon: "hard-drive-download", url: "http://hsb0.lan:8501/", sameHost: true, port: ":8501" },
    { wing: "network", name: "hausnetz", unit: "hausnetz.service", purpose: "Live 3D map of the house network", icon: "workflow", url: "http://hsb0.lan/ops/", sameHost: true, path: "/ops/", note: "LAN-only (192.168.1.0/24); other networks get 403" },
    { wing: "network", name: "NCPS warmer", unit: "ncps-warmer.timer", purpose: "Warms NCPS with the LAN fleet's closures", icon: "hard-drive-download", passive: true, foot: "Sat + Mon 04:00 · scheduled" },

    { wing: "agents", name: "In flight", purpose: "AEON-LEAD progress overview", icon: "grid-3x3", url: "http://hsb0.lan/inflight/", sameHost: true, path: "/inflight/" },
    { wing: "agents", name: "IB Gateway", container: "ib-gateway", purpose: "Paper Interactive Brokers API for the desks", icon: "server", passive: true, foot: "tailnet :4002 · paper API" },
    { wing: "agents", name: "IB session supervisor", unit: "ib-gateway-session.timer", purpose: "Paper Gateway session-readiness checks", icon: "refresh-cw", passive: true, foot: "5 min timer · supervisor" },
    { wing: "agents", name: "paper-desk-executor", container: "paper-desk-executor", purpose: "Paper order intents from tailnet desks", icon: "briefcase", passive: true, foot: "tailnet :8470 · API" },
    { wing: "agents", name: "agent-mailbox", container: "agent-mailbox", purpose: "Tailnet text mailbox for Amy and OPS", icon: "mail", passive: true, foot: "tailnet :8471 · API" },
    { wing: "agents", name: "joe-board-pusher", container: "joe-board-pusher", purpose: "Paper Gateway reports to the Joe board on csb0", icon: "radar", passive: true, foot: "30 s push · outbound only" },

    { wing: "telemetry", name: "Speedtest Tracker", container: "speedtest-tracker", purpose: "Starlink WAN speed history and scheduled checks", icon: "logo-speedtest", url: "http://hsb0.lan:8765/", sameHost: true, port: ":8765" },
    { wing: "telemetry", name: "Uptime Kuma", unit: "uptime-kuma.service", purpose: "LAN service uptime checks and alerts", icon: "bell-ring", url: "http://hsb0.lan:3001/", sameHost: true, port: ":3001" },
    { wing: "telemetry", name: "pharos-beacon", container: "pharos-beacon", purpose: "Host status to pharosd on csb1", icon: "radar", passive: true, foot: "beacon · outbound only" },
    { wing: "telemetry", name: "UPS MQTT", unit: "ups-mqtt-publish.timer", purpose: "Eaton UPS status (NUT) published into MQTT", icon: "logo-mqtt", passive: true, foot: "1 min timer · no UI" },

    { wing: "housekeeping", name: "restic", container: "restic-cron-hetzner", purpose: "Nightly backup to Hetzner Storage Box", icon: "hard-drive-download", passive: true, foot: "02:00 daily · backup" },
    { wing: "housekeeping", name: "SMTP relay", container: "docker-smtp-1", purpose: "Outbound container mail through Resend", icon: "mail", passive: true, foot: ":25 internal · relay" },
    { wing: "housekeeping", name: "Container updates", unit: "compose-hsb0-update.timer", purpose: "Weekly updates for the compose stack", icon: "refresh-cw", passive: true, foot: "Sat 05:00 · scheduled" },
    { wing: "housekeeping", name: "LG Developer Mode", unit: "lg-devmode-renew.timer", purpose: "Daily webOS Developer Mode renewal for the LG beamer", icon: "refresh-cw", passive: true, foot: "daily · scheduled" },
  ],
};
