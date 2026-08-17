<!--
  Doctrine loader — studio repository.

  Vendors both halves: the public identity-free baseline, and the private
  operator layer (identity, fleet, trackers, preferences).

  Precedence: public kernel < private kernel < this repo's own notes.
  Bump:   git submodule update --remote doctrine doctrine-private
  Verify: ./doctrine/scripts/doctrine-check.sh
-->

@./doctrine/docs/AGENTS-KERNEL.md
@./doctrine-private/docs/AGENTS-KERNEL-PRIVATE.md

## Commands wired in this repo

Authoritative for what is wired here; `doctrine-check.sh` diffs this against
`.claude/commands/`.

| Command | Loads |
| --- | --- |
| `/dev` | Code, tests, git workflow |
| `/nix` | Nix, flakes, Home Manager |
| `/inspr` | Doctrine map |
| `/push` | Single-repo commit + push |
| `/ppm` | Paimos tickets + planning |
| `/ops` | Fleet, SSH, deploys |
| `/iac` | Terraform / Zitadel / Cloudflare |
| `/secrets` | Secret-handling pipeline |
| `/style` | Operator profile |
| `/incident` | Leak protocol |
