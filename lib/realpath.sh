# Canonicalize a symlink's target to an absolute real path, following the whole
# chain -- portable across readlink flavors. Prefer `readlink -f` (GNU coreutils,
# macOS 12.3+); fall back to a POSIX resolve loop where `-f` is unavailable (BSD
# readlink on macOS < 12.3 rejects -f and prints nothing). Prints the canonical
# path, or NOTHING on any failure.
#
# Sourced by BOTH ./setup and ./uninstall so the two can never drift. That
# shared silence-on-failure contract is what each side's safety rests on, from
# opposite directions: an unresolved target reads as FOREIGN, so setup's
# `ln -snf` never hijacks a link it could not prove is ours, and uninstall
# leaves it alone rather than deleting it. A portability gap can therefore only
# ever under-act, never clobber or destroy a user's file.
_realpath() {
  local p="$1" out
  # Fast path: GNU / macOS 12.3+ `readlink -f` canonicalizes in one shot.
  out="$(readlink -f "$p" 2>/dev/null)" && [ -n "$out" ] && { printf '%s\n' "$out"; return 0; }
  # Fallback: follow the symlink chain by hand, then canonicalize the parent dir
  # via `cd ... && pwd -P` (resolves symlinks in the parent components too, so the
  # result matches PACK_DIR's own pwd -P form for the string compare).
  local target n=0
  while [ -L "$p" ]; do
    n=$((n + 1)); [ "$n" -gt 40 ] && return 1   # cycle guard
    target="$(readlink "$p")" || return 1
    case "$target" in
      /*) p="$target" ;;                    # absolute target
      *)  p="$(dirname "$p")/$target" ;;    # target relative to the link's dir
    esac
  done
  out="$(cd "$(dirname "$p")" 2>/dev/null && pwd -P)" || return 1
  printf '%s/%s\n' "$out" "$(basename "$p")"
}
