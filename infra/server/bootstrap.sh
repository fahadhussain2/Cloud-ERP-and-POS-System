#!/usr/bin/env bash
# Configures an Ubuntu 24.04 server for the ERP (W0-03, D-073). Run as root, normally through apply.sh.
# Idempotent: a second run changes nothing and says so.
#
#   --lock-ssh  also turn off root and password logins. Use only after an `admin` login has been tested.
#               Once applied, later runs keep it.
#   --upgrade   also install all pending package upgrades.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
FILES=$HERE/files
DOCKER_KEY_FPR=9DC858229FC7DD38854AE2D88D81803C0EBFCD88
SSH_HARDENING=/etc/ssh/sshd_config.d/10-erp-hardening.conf

LOCK_SSH=0
UPGRADE=0
for arg in "$@"; do
  case $arg in
    --lock-ssh) LOCK_SSH=1 ;;
    --upgrade) UPGRADE=1 ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

CHANGES=0
FILE_CHANGED=0
APT_UPDATED=0
export DEBIAN_FRONTEND=noninteractive

step() { echo "== $*"; }
changed() {
  CHANGES=$((CHANGES + 1))
  echo "   changed: $*"
}
die() {
  echo "ERROR: $*" >&2
  exit 1
}

# put_file SRC DEST MODE [OWNER]: install SRC at DEST if content, mode or owner differ. Sets FILE_CHANGED.
put_file() {
  local src=$1 dest=$2 mode=$3 owner=${4:-root:root}
  FILE_CHANGED=0
  if [[ ! -f $dest ]] || ! cmp -s "$src" "$dest"; then
    install -D -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$src" "$dest"
    FILE_CHANGED=1
  elif [[ $(stat -c '%a %U:%G' "$dest") != "$mode $owner" ]]; then
    chmod "$mode" "$dest"
    chown "$owner" "$dest"
    FILE_CHANGED=1
  fi
  if ((FILE_CHANGED)); then changed "$dest"; fi
}

apt_update() {
  if ((!APT_UPDATED)); then
    apt-get update -qq
    APT_UPDATED=1
  fi
}

ensure_pkgs() {
  local missing=() p
  for p in "$@"; do
    [[ $(dpkg-query -W -f='${Status}' "$p" 2>/dev/null) == 'install ok installed' ]] || missing+=("$p")
  done
  if ((${#missing[@]})); then
    apt_update
    apt-get install -y -qq --no-install-recommends "${missing[@]}" >/dev/null
    changed "installed ${missing[*]}"
  fi
}

ensure_service() {
  local unit=$1
  systemctl is-enabled --quiet "$unit" || {
    systemctl enable --quiet "$unit"
    changed "enabled $unit"
  }
  systemctl is-active --quiet "$unit" || {
    systemctl start "$unit"
    changed "started $unit"
  }
}

# ensure_user NAME [GROUP...]: a login user with a locked password (keys only).
ensure_user() {
  local user=$1 group
  shift
  if ! id "$user" &>/dev/null; then
    useradd --create-home --shell /bin/bash "$user"
    changed "user $user"
  fi
  for group in "$@"; do
    [[ " $(id -nG "$user") " == *" $group "* ]] || {
      usermod -aG "$group" "$user"
      changed "$user added to $group"
    }
  done
}

key_files() {
  local files
  shopt -s nullglob
  files=("$HERE/keys/$1/"*.pub)
  shopt -u nullglob
  if ((${#files[@]})); then printf '%s\n' "${files[@]}"; fi
}

# authorized_keys is fully managed: a key removed from keys/<user>/ is revoked on the next run.
ensure_keys() {
  local user=$1 home keys=()
  home=$(getent passwd "$user" | cut -d: -f6)
  mapfile -t keys < <(key_files "$user")
  install -d -m 700 -o "$user" -g "$user" "$home/.ssh"
  # Not a pipe: put_file must run in this shell so its change count is kept.
  local tmp
  tmp=$(mktemp)
  cat /dev/null "${keys[@]}" >"$tmp"
  put_file "$tmp" "$home/.ssh/authorized_keys" 600 "$user:$user"
  rm -f "$tmp"
}

[[ $EUID -eq 0 ]] || die "run as root"
# shellcheck source=/dev/null
. /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || die "expected Ubuntu 24.04, found $PRETTY_NAME"

step "Base packages"
ensure_pkgs ca-certificates curl gnupg ufw fail2ban python3-systemd unattended-upgrades

if ((UPGRADE)); then
  step "Package upgrades"
  apt_update
  if [[ -n $(apt list --upgradable 2>/dev/null | tail -n +2) ]]; then
    apt-get full-upgrade -y -qq >/dev/null
    changed "upgraded packages"
  fi
fi

step "Clock"
[[ $(timedatectl show -p Timezone --value) == Etc/UTC ]] || {
  timedatectl set-timezone Etc/UTC
  changed "timezone Etc/UTC"
}

step "Swap and kernel settings"
if [[ $(swapon --show=NAME --noheadings) != *"/swapfile"* ]]; then
  if [[ ! -f /swapfile ]]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  swapon /swapfile
  changed "swap /swapfile on"
fi
grep -q '^/swapfile ' /etc/fstab || {
  echo '/swapfile none swap sw 0 0' >>/etc/fstab
  changed "/etc/fstab swap entry"
}
put_file "$FILES/sysctl/90-erp.conf" /etc/sysctl.d/90-erp.conf 644
if ((FILE_CHANGED)); then sysctl --system >/dev/null; fi

step "Docker"
if [[ ! -f /etc/apt/keyrings/docker.asc ]]; then
  tmp=$(mktemp)
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o "$tmp"
  fingerprints=$(gpg --show-keys --with-colons "$tmp" 2>/dev/null | awk -F: '/^fpr/ {print $10}')
  grep -qx "$DOCKER_KEY_FPR" <<<"$fingerprints" || die "Docker signing key fingerprint does not match $DOCKER_KEY_FPR"
  install -D -m 644 "$tmp" /etc/apt/keyrings/docker.asc
  rm -f "$tmp"
  changed "Docker signing key"
fi
put_file "$FILES/apt/docker.sources" /etc/apt/sources.list.d/docker.sources 644
if ((FILE_CHANGED)); then APT_UPDATED=0; fi
ensure_pkgs docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
put_file "$FILES/docker/daemon.json" /etc/docker/daemon.json 644
if ((FILE_CHANGED)) && systemctl is-active --quiet docker; then systemctl restart docker; fi
ensure_service docker

step "Users and keys"
[[ -n $(key_files admin) ]] || die "no admin keys in keys/admin/"
ensure_user admin sudo adm systemd-journal
ensure_keys admin
put_file "$FILES/sudoers/90-erp-admin" /etc/sudoers.d/90-erp-admin 440
visudo -cqf /etc/sudoers.d/90-erp-admin || die "invalid sudoers file"
# deploy runs Docker for GitHub Actions: Docker access only, no sudo. Its key may run only
# erp-deploy (forced command in keys/deploy/*.pub, D-075).
ensure_user deploy docker
ensure_keys deploy
put_file "$FILES/bin/erp-deploy" /usr/local/bin/erp-deploy 755
install -d -m 755 /srv/erp /srv/erp/edge
for env in prod staging; do
  [[ -d /srv/erp/$env ]] || changed "/srv/erp/$env"
  install -d -m 750 -o deploy -g deploy "/srv/erp/$env"
done

step "Firewall (ufw)"
before=$(ufw status verbose)
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw --force enable >/dev/null
[[ $before == "$(ufw status verbose)" ]] || changed "ufw rules"

step "fail2ban"
put_file "$FILES/fail2ban/erp.local" /etc/fail2ban/jail.d/erp.local 644
if ((FILE_CHANGED)); then systemctl restart fail2ban; fi
ensure_service fail2ban

step "Automatic security upgrades"
put_file "$FILES/apt/20auto-upgrades" /etc/apt/apt.conf.d/20auto-upgrades 644
put_file "$FILES/apt/52erp-unattended-upgrades" /etc/apt/apt.conf.d/52erp-unattended-upgrades 644
put_file "$FILES/systemd/apt-daily-upgrade-erp.conf" /etc/systemd/system/apt-daily-upgrade.timer.d/erp.conf 644
if ((FILE_CHANGED)); then
  systemctl daemon-reload
  systemctl restart apt-daily-upgrade.timer
fi

step "SSH"
if ((LOCK_SSH)) || [[ -f $SSH_HARDENING ]]; then
  put_file "$FILES/ssh/10-erp-hardening.conf" "$SSH_HARDENING" 644
  if ((FILE_CHANGED)); then
    sshd -t || {
      rm -f "$SSH_HARDENING"
      die "sshd rejected the hardening file; it was removed"
    }
    # Existing sessions stay open. If ssh is socket-activated and idle, the next connection reads the new file.
    systemctl try-reload-or-restart ssh
  fi
else
  echo "   pending: root and password logins are still on. Test 'ssh admin@<server>', then run again with --lock-ssh."
fi

echo
if ((CHANGES)); then echo "Done: $CHANGES change(s)."; else echo "Done: no changes."; fi
if [[ -f /var/run/reboot-required ]]; then echo "Note: a reboot is required (see /var/run/reboot-required.pkgs)."; fi
