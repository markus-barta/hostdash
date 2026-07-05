window.HOSTDASH_CONFIG = {
  slug: "hsb1",
  storageKey: "hostdash.hsb1",
  host: {
    name: "hsb1",
    role: "home server",
    os: "NixOS",
    fqdn: "hsb1.lan",
    ip: "192.168.1.101",
    title: "hsb1 · home server",
    heading: "Services",
  },
  meta: [
    { text: "hosts/hsb1/docker", code: true },
    { text: "hsb1-home", code: true },
    "Europe/Vienna",
  ],
  wings: [
    { id: "home", name: "Home & Automation", color: "var(--home)", icon: "house" },
    { id: "media", name: "Media & Play", color: "var(--media)", icon: "clapperboard" },
    { id: "signals", name: "Signals & Messaging", color: "var(--signals)", icon: "radio" },
    { id: "safety", name: "Cameras & Safety", color: "var(--safety)", icon: "camera" },
    { id: "infra", name: "Housekeeping", color: "var(--infra)", icon: "refresh-cw" },
  ],
  services: [
    { wing: "home", name: "Home Assistant", purpose: "Smart-home hub & automations", icon: "logo-ha", url: "http://hsb1.lan:8123/", port: ":8123" },
    { wing: "home", name: "Node-RED", purpose: "Visual flow automation", icon: "logo-nodered", url: "http://hsb1.lan:1880/", port: ":1880" },
    { wing: "home", name: "Zigbee2MQTT", purpose: "Zigbee to MQTT bridge", icon: "logo-z2m", url: "http://hsb1.lan:8888/", port: ":8888" },
    { wing: "home", name: "opusweb", purpose: "OPUS greenNet EnOcean control", icon: "sliders", url: "http://hsb1.lan:3102/", port: ":3102" },
    { wing: "home", name: "Matter Server", purpose: "Matter/Thread controller for HA", icon: "hexagon", passive: true, foot: ":5580 api · no UI" },

    { wing: "media", name: "Plex", purpose: "Media library & streaming", icon: "logo-plex", url: "http://hsb1.lan:32400/web", port: ":32400" },
    { wing: "media", name: "pixdcon", purpose: "Pixoo pixel-display controller", icon: "logo-pixdcon", url: "http://hsb1.lan:8080/", port: ":8080" },
    { wing: "media", name: "funkeykid", purpose: "Kids audio/voice toy console", icon: "toy-brick", url: "http://hsb1.lan:8081/", port: ":8081" },

    { wing: "signals", name: "Apprise", purpose: "Unified notification gateway", icon: "logo-apprise", url: "http://hsb1.lan:8001/", port: ":8001" },
    { wing: "signals", name: "Mosquitto", purpose: "MQTT broker and message bus", icon: "logo-mqtt", passive: true, foot: ":1883 · :9001 ws · broker" },
    { wing: "signals", name: "opus-stream-to-mqtt", purpose: "OPUS gateway to MQTT bridge", icon: "audio-waveform", passive: true, foot: "agent · no UI" },
    { wing: "signals", name: "SMTP relay", purpose: "Outbound container mail", icon: "mail", passive: true, foot: ":25 internal · relay" },

    { wing: "safety", name: "Scrypted", purpose: "Camera/NVR hub to HomeKit/HA", icon: "logo-scrypted", url: "https://hsb1.lan:10443/", port: ":10443", certIssue: true, note: "service answers with a self-signed localhost certificate" },
    { wing: "safety", name: "fritz-tripwire", purpose: "Snapshots mesh on device drop", icon: "shield-alert", url: "http://hsb1.lan:9000/", port: ":9000", note: "plain-text status endpoint" },

    { wing: "infra", name: "Watchtower", purpose: "Weekly container auto-updates", icon: "refresh-cw", passive: true, foot: "Sat 05:00 · scheduled" },
    { wing: "infra", name: "restic", purpose: "Nightly backup to Hetzner", icon: "hard-drive-download", passive: true, foot: "01:30 daily · backup" },
    { wing: "infra", name: "FleetCom", purpose: "Heartbeats to fleet.barta.cm", icon: "satellite-dish", passive: true, foot: "agent · no UI" },
    { wing: "infra", name: "pharos-beacon", purpose: "Host status to pharosd on csb1", icon: "radar", passive: true, foot: "beacon · outbound only" },
    { wing: "infra", name: "claude-code", purpose: "Idle Claude Code shell", icon: "terminal", passive: true, foot: "shell · no UI" },
  ],
};
