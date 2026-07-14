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
    { wing: "home", name: "Home Assistant", container: "homeassistant", purpose: "Smart-home hub & automations", icon: "logo-ha", url: "http://hsb1.lan:8123/", sameHost: true, port: ":8123" },
    { wing: "home", name: "Node-RED", container: "nodered", purpose: "Visual flow automation", icon: "logo-nodered", url: "http://hsb1.lan:1880/", sameHost: true, port: ":1880" },
    { wing: "home", name: "Zigbee2MQTT", container: "zigbee2mqtt", purpose: "Zigbee to MQTT bridge", icon: "logo-z2m", url: "http://hsb1.lan:8888/", sameHost: true, port: ":8888" },
    { wing: "home", name: "opusweb", container: "opusweb", purpose: "OPUS greenNet EnOcean control", icon: "sliders", url: "http://hsb1.lan:3102/", sameHost: true, port: ":3102" },
    { wing: "home", name: "Matter Server", container: "matter-server", purpose: "Matter/Thread controller for HA", icon: "hexagon", passive: true, foot: ":5580 api · no UI" },

    { wing: "media", name: "Plex", container: "plex", purpose: "Media library & streaming", icon: "logo-plex", url: "http://hsb1.lan:32400/web", sameHost: true, port: ":32400", path: "/web" },
    { wing: "media", name: "pixdcon", container: "pixdcon", purpose: "Pixoo pixel-display controller", icon: "logo-pixdcon", url: "http://hsb1.lan:8080/", sameHost: true, port: ":8080" },
    { wing: "media", name: "funkeykid", container: "funkeykid", purpose: "Kids audio/voice toy console", icon: "toy-brick", url: "http://hsb1.lan:8081/", sameHost: true, port: ":8081" },

    { wing: "signals", name: "Apprise", container: "apprise", purpose: "Unified notification gateway", icon: "logo-apprise", url: "http://hsb1.lan:8001/", sameHost: true, port: ":8001" },
    { wing: "signals", name: "Mosquitto", container: "mosquitto", purpose: "MQTT broker and message bus", icon: "logo-mqtt", passive: true, foot: ":1883 · :9001 ws · broker" },
    { wing: "signals", name: "opus-stream-to-mqtt", container: "opus-stream-to-mqtt", purpose: "OPUS gateway to MQTT bridge", icon: "audio-waveform", passive: true, foot: "agent · no UI" },
    { wing: "signals", name: "SMTP relay", container: "docker-smtp-1", purpose: "Outbound container mail", icon: "mail", passive: true, foot: ":25 internal · relay" },

    // The babycam kiosk has no HTTP endpoint and could never be probed by a browser.
    // It publishes real health instead (NIX-151): decoder counters proving frames and
    // audio are actually MOVING, plus the volume the user ASKED for vs what VLC is doing.
    // `desired_volume: 0` is a deliberate nightly mute, NOT a fault — see extraState().
    { wing: "safety", name: "Babycam", purpose: "Kiosk feed \u2014 audio + video watchdog", icon: "camera", passive: true, extra: "babycam", foot: "kiosk \u00b7 self-healing" },
    { wing: "safety", name: "Scrypted", container: "scrypted", purpose: "Camera/NVR hub to HomeKit/HA", icon: "logo-scrypted", url: "https://hsb1.lan:10443/", sameHost: true, scheme: "https:", port: ":10443", certIssue: true, note: "service answers with a self-signed localhost certificate" },
    { wing: "safety", name: "fritz-tripwire", container: "fritz-tripwire", purpose: "Snapshots mesh on device drop", icon: "shield-alert", url: "http://hsb1.lan:9000/", sameHost: true, port: ":9000", note: "plain-text status endpoint" },

    { wing: "infra", name: "Watchtower", container: "watchtower-weekly", purpose: "Weekly container auto-updates", icon: "refresh-cw", passive: true, foot: "Sat 05:00 · scheduled" },
    { wing: "infra", name: "restic", container: "restic-cron-hetzner", purpose: "Nightly backup to Hetzner", icon: "hard-drive-download", passive: true, foot: "01:30 daily · backup" },
    { wing: "infra", name: "pharos-beacon", container: "pharos-beacon", purpose: "Host status to pharosd on csb1", icon: "radar", passive: true, foot: "beacon · outbound only" },
    { wing: "infra", name: "claude-code", purpose: "Idle Claude Code shell", icon: "terminal", passive: true, foot: "shell · no UI" },
  ],
};
