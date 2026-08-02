#!/bin/sh
# Canonicalize the guide harness's per-scenario mock command logs.
#
# Every documented command the harness drives is recorded verbatim, so the set
# of logs is a precise description of what the guide does. That makes it the
# evidence of choice when a change is supposed to be behaviour-preserving:
# convert the mocks, refactor a block, dedupe a case arm, then show that every
# scenario still issues exactly the same commands in the same order.
#
# A handful of tokens in those logs are genuinely nondeterministic, so a raw
# diff is useless. This script masks exactly those tokens and nothing else.
#
# Reproducing the byte-identity evidence takes two commands per side:
#
#   # on the base revision
#   PP_KEEP_TMP=1 sh infra/azure/tests/guide_commands_test.sh
#   sh infra/azure/tests/canonicalize_guide_logs.sh "$PRESERVED_ROOT" /tmp/logs-base
#
#   # on the changed revision
#   PP_KEEP_TMP=1 sh infra/azure/tests/guide_commands_test.sh
#   sh infra/azure/tests/canonicalize_guide_logs.sh "$PRESERVED_ROOT" /tmp/logs-head
#
#   diff -r /tmp/logs-base /tmp/logs-head
#
# PP_KEEP_TMP=1 makes the harness skip its cleanup and print the temporary root
# it preserved; that printed path is $PRESERVED_ROOT. An empty diff means every
# scenario issued the same commands in the same order.
#
# Before trusting an empty diff, validate the masking itself: run the same
# revision twice and confirm those two canonicalized sets also compare equal.
# If they do not, this script is under-masking and the evidence is worthless.
#
# What is masked, and why each token varies between runs:
#
#   @TMP@       the harness's mktemp -d root, in both its logical and its
#               physical (symlink-resolved) spelling
#   @MKTEMP@    the six random characters mktemp appends to the guide's own
#               templates (patchpage-registry-target.XXXXXX and friends)
#   @GUIDn@     UUIDs, chiefly the proposed operation-lease IDs the guide
#               generates per run
#   @TAG@       the 32 random hex characters the release flow appends to the
#               full-commit image tag
#
# UUIDs are renumbered per file in order of first appearance rather than
# collapsed to a single token: within one scenario, "the same lease ID came
# back" and "a different lease ID came back" stay distinguishable, and a
# reordering of two distinct UUIDs still shows up as a diff. The numbering is
# per file, so an unrelated scenario cannot shift another scenario's numbers.
#
# The masking is deliberately narrow. Fixed identifiers -- the test
# subscription ID, the built-in role definition IDs, the workload binding
# SHA-256, the pinned image digests -- are ordinary UUIDs and hex strings, and
# they are left alone so that a change to any of them shows up as a diff.

set -eu

usage() {
  printf 'usage: canonicalize_guide_logs.sh <preserved-tmp-root> <out-dir> [suffix]\n' >&2
  printf '  suffix defaults to .log (the mock command logs)\n' >&2
  exit 2
}

test "$#" -ge 2 || usage
test "$#" -le 3 || usage

tmp_root="$1"
out_dir="$2"
suffix="${3:-.log}"

test -d "$tmp_root" || {
  printf 'canonicalize_guide_logs: no such directory: %s\n' "$tmp_root" >&2
  exit 1
}

log_dir="$tmp_root/guide commands"
test -d "$log_dir" || {
  printf 'canonicalize_guide_logs: %s does not look like a preserved harness root\n' \
    "$tmp_root" >&2
  exit 1
}

# The logs record physical paths, while the printed root is whatever mktemp -d
# returned; on macOS those differ by the /private prefix. Mask both spellings.
tmp_root_physical="$(CDPATH= cd -- "$tmp_root" && pwd -P)"

mkdir -p "$out_dir"

canonicalized=0
for log_file in "$log_dir"/*"$suffix"; do
  test -f "$log_file" || continue
  awk -v tmp_root="$tmp_root" -v tmp_root_physical="$tmp_root_physical" '
    function replace_literal(s, from, to,   out, at) {
      if (from == "") {
        return s
      }
      out = ""
      while ((at = index(s, from)) > 0) {
        out = out substr(s, 1, at - 1) to
        s = substr(s, at + length(from))
      }
      return out s
    }

    # patchpage-registry-target.r3cJcF -> patchpage-registry-target.@MKTEMP@
    function mask_mktemp(s,   out, token, boundary) {
      out = ""
      # Pad so a suffix at end of line still has the trailing boundary the
      # pattern needs; the pad is stripped again below.
      s = s " "
      while (match(s, mktemp_re)) {
        token = substr(s, RSTART, RLENGTH)
        boundary = substr(token, length(token), 1)
        # token is <prefix>.<6 random chars><boundary>
        out = out substr(s, 1, RSTART - 1) \
          substr(token, 1, length(token) - 7) "@MKTEMP@" boundary
        s = substr(s, RSTART + RLENGTH)
      }
      s = out s
      return substr(s, 1, length(s) - 1)
    }

    function mask_uuids(s,   out, token) {
      out = ""
      while (match(s, uuid_re)) {
        token = substr(s, RSTART, RLENGTH)
        if (!(token in uuid_number)) {
          uuid_seen++
          uuid_number[token] = uuid_seen
        }
        out = out substr(s, 1, RSTART - 1) "@GUID" uuid_number[token] "@"
        s = substr(s, RSTART + RLENGTH)
      }
      return out s
    }

    # A 32-hex run bounded by non-hex on both sides. The 40-hex commit SHA and
    # the 64-hex digests and binding hashes are longer runs, so they never
    # satisfy both boundaries and are left intact.
    function mask_tag(s,   out, token) {
      out = ""
      s = " " s " "
      while (match(s, tag_re)) {
        token = substr(s, RSTART, RLENGTH)
        out = out substr(s, 1, RSTART - 1) substr(token, 1, 1) "@TAG@" \
          substr(token, length(token), 1)
        s = substr(s, RSTART + RLENGTH)
      }
      s = out s
      return substr(s, 2, length(s) - 2)
    }

    BEGIN {
      hex = "[0-9a-f]"
      uuid_re = hex "{8}-" hex "{4}-" hex "{4}-" hex "{4}-" hex "{12}"
      tag_re = "[^0-9a-f]" hex "{32}[^0-9a-f]"
      mktemp_re = "(patchpage-[A-Za-z0-9-]+|stderr|tmp)\\.[A-Za-z0-9]{6}[^A-Za-z0-9]"
      uuid_seen = 0
    }

    {
      line = $0
      line = replace_literal(line, tmp_root_physical, "@TMP@")
      line = replace_literal(line, tmp_root, "@TMP@")
      line = mask_mktemp(line)
      line = mask_uuids(line)
      line = mask_tag(line)
      print line
    }
  ' "$log_file" > "$out_dir/${log_file##*/}"
  canonicalized=$((canonicalized + 1))
done

printf 'canonicalize_guide_logs: %d file(s) -> %s\n' "$canonicalized" "$out_dir"
