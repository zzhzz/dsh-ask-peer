#!/usr/bin/env bash

# Ask before stopping processes that occupy ports required by a local test.
# Non-interactive runs fail closed so CI never kills an unrelated process.
ensure_test_ports_free() {
  local ports=("$@")
  local occupied_ports=()
  local occupied_pids=()
  local seen_pids=" "
  local port pid reply still_busy port_occupied

  for port in "${ports[@]}"; do
    port_occupied=false
    while IFS= read -r pid; do
      [ -n "$pid" ] || continue
      port_occupied=true
      case "$seen_pids" in
        *" $pid "*) ;;
        *)
          occupied_pids+=("$pid")
          seen_pids+="$pid "
          ;;
      esac
    done < <(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
    if [ "$port_occupied" = true ]; then
      occupied_ports+=("$port")
    fi
  done

  if [ "${#occupied_ports[@]}" -eq 0 ]; then
    return 0
  fi

  echo "The following test ports are already in use:" >&2
  for port in "${occupied_ports[@]}"; do
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >&2 || true
  done

  if [ -n "${CI:-}" ] || [ ! -t 0 ]; then
    echo "Cannot ask for confirmation in CI or a non-interactive run; exiting without stopping anything." >&2
    return 1
  fi

  printf 'Kill the listed processes and continue the test? [y/N] ' >&2
  IFS= read -r reply
  case "$reply" in
    [yY] | [yY][eE][sS]) ;;
    *)
      echo "Test cancelled; no process was stopped." >&2
      return 1
      ;;
  esac

  # A process can own more than one required port, so signal each PID once.
  kill "${occupied_pids[@]}" 2>/dev/null || true

  for _ in $(seq 1 50); do
    still_busy=false
    for port in "${ports[@]}"; do
      if lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
        still_busy=true
        break
      fi
    done
    if [ "$still_busy" = false ]; then
      echo "Required test ports are now free; continuing."
      return 0
    fi
    sleep 0.1
  done

  echo "Some required ports are still occupied after SIGTERM; exiting." >&2
  for port in "${ports[@]}"; do
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >&2 || true
  done
  return 1
}
