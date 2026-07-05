{
  description = "Static service dashboard for hsb1 and reusable host dashboards";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
        "x86_64-darwin"
      ];

      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;

      mkDashboardPackage =
        pkgs:
        {
          pname,
          src,
          metaDescription,
        }:
        pkgs.stdenvNoCC.mkDerivation {
          inherit pname src;
          version = "0.1.0";

          dontConfigure = true;
          dontBuild = true;

          installPhase = ''
            runHook preInstall
            install -d "$out/share/${pname}"
            cp -R . "$out/share/${pname}/"
            runHook postInstall
          '';

          meta = {
            description = metaDescription;
            platforms = supportedSystems;
          };
        };
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          hsb1 = mkDashboardPackage pkgs {
            pname = "hsb1-home-dashboard";
            src = ./public;
            metaDescription = "Static hsb1 service dashboard";
          };
        in
        {
          inherit hsb1;
          default = hsb1;
        }
      );
    };
}
