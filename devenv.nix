{ pkgs, ... }:

{
  # Node.js and pnpm are both provided by languages.javascript below.
  # playwright-driver provides pre-built Chromium for NixOS (no sudo install needed).
  # agent-browser is the CDP browser-automation CLI agents use for QA and
  # visual feedback; it drives the same Chromium (see enterShell below).
  packages = [
    pkgs.playwright-driver.browsers
    pkgs.agent-browser
    pkgs.jq
    pkgs.gawk
    pkgs.rsync
  ];

  # Load .env into the shell environment. The API server reads process.env
  # directly (no dotenv package), so env vars must be set before starting it.
  # Non-devenv users: source .env manually or use a tool like direnv/dotenv-cli.
  dotenv.enable = true;

  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_26;
    # pnpm is managed by the javascript module (gives pnpm 11 on nixos-unstable).
    # Corepack is intentionally not used; the pnpm version constraint lives in
    # the root package.json `engines.pnpm` field.
    pnpm.enable = true;
  };

  services.postgres = {
    enable = true;
    package = pkgs.postgresql_17;
    initialDatabases = [{ name = "libris"; }];
    listen_addresses = "127.0.0.1";
  };

  services.redis = {
    enable = true;
    bind = "127.0.0.1";
  };

  enterShell = ''
    # Playwright: use Nix-provided browsers instead of downloading via sudo
    export PLAYWRIGHT_BROWSERS_PATH="${pkgs.playwright-driver.browsers}"
    export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true

    # agent-browser: reuse the Playwright Chromium instead of running
    # `agent-browser install`, which downloads Chrome for Testing and cannot
    # run on NixOS (no FHS layout). The revision-suffixed directory name comes
    # from the nixpkgs pin, so glob it rather than hardcoding it.
    agent_browser_chrome="$(echo ${pkgs.playwright-driver.browsers}/chromium-*/chrome-linux64/chrome)"
    if [ -x "$agent_browser_chrome" ]; then
      export AGENT_BROWSER_EXECUTABLE_PATH="$agent_browser_chrome"
    else
      echo "devenv: warning: no Chromium under ${pkgs.playwright-driver.browsers}; agent-browser will not launch" >&2
    fi
    unset agent_browser_chrome
  '';
}
