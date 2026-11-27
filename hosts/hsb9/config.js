window.HOSTDASH_CONFIG = {
  slug: "hsb9",
  storageKey: "hostdash.hsb9",
  host: {
    name: "hsb9",
    role: { en: "parents-in-law", de: "Zuhause" },
    os: "NixOS",
    fqdn: "hsb9.lan",
    ip: "192.168.1.200",
    title: { en: "hsb9 · parents-in-law", de: "hsb9 · Zuhause" },
    heading: { en: "Services", de: "Dienste" },
  },
  meta: [
    { text: "hosts/hsb9/docker", code: true },
    { text: "hsb9-home", code: true },
    { en: "Europe/Vienna", de: "Europa/Wien" },
  ],
  wings: [
    { id: "home", name: { en: "Home & Media", de: "Zuhause & Medien" }, color: "var(--home)", icon: "house" },
    { id: "ops", name: { en: "Fleet & Ops", de: "Betrieb" }, color: "var(--signals)", icon: "radar" },
    { id: "housekeeping", name: { en: "Housekeeping", de: "Wartung" }, color: "var(--infra)", icon: "refresh-cw" },
  ],
  services: [
    { wing: "home", name: "Home Assistant", container: "homeassistant", purpose: { en: "Parents-in-law home automation hub", de: "Hausautomation: Licht, Geräte und Szenen" }, icon: "logo-ha", url: "http://hsb9.lan:8123/", sameHost: true, port: ":8123" },
    { wing: "home", name: "Fernsehaufnahmen", container: "hsb9-media", purpose: { en: "Watch, rename and tidy up TV recordings", de: "Aufnahmen ansehen, umbenennen, aufräumen" }, icon: "clapperboard", url: "http://hsb9.lan/fernsehen/", sameHost: true, path: "/fernsehen/" },
    { wing: "home", name: "Mosquitto", container: "mosquitto", purpose: { en: "MQTT broker for local automations", de: "Nachrichtenzentrale (MQTT) für die Hausautomation" }, icon: "logo-mqtt", passive: true, foot: { en: ":1883 · broker", de: ":1883 · Broker" } },

    { wing: "ops", name: "pharos-beacon", container: "pharos-beacon", purpose: { en: "Host status to pharosd on csb1", de: "Meldet den Gerätestatus an pharosd auf csb1" }, icon: "radar", passive: true, foot: { en: "beacon · outbound only", de: "Beacon · nur ausgehend" } },

    { wing: "housekeeping", name: "restic", container: "restic-cron-hetzner", purpose: { en: "Nightly backup to Hetzner Storage Box", de: "Nächtliche Sicherung zur Hetzner Storage Box" }, icon: "hard-drive-download", passive: true, foot: { en: "03:00 daily · backup", de: "03:00 täglich · Sicherung" } },
    { wing: "housekeeping", name: { en: "Container updates", de: "Container-Updates" }, unit: "compose-hsb9-update.timer", purpose: { en: "Weekly updates for the compose stack", de: "Wöchentliche Updates für den Compose-Stack" }, icon: "refresh-cw", passive: true, foot: { en: "Sat 05:00 · scheduled", de: "Sa 05:00 · geplant" } },
  ],
};
