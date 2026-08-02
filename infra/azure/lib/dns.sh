# Reading a dig response.
#
# Sourced by cmd/*.sh through ops.sh, which exports PP_OPS_LIB; see ops.sh.
#
# apex-dns and caa-policy both have to distinguish "the name does not have this
# record" from "the lookup did not work", and dig does not make that easy: it
# exits 0 for NXDOMAIN and SERVFAIL alike, and prints an empty answer section
# for both. The only reliable signal is the DNS status word in the header
# comment, which is why both commands ask for `+noall +comments +answer` and
# then parse the header rather than trusting the exit status or an empty answer.
#
# Getting that wrong in one place and not the other is the failure that matters:
# a SERVFAIL read as "no AAAA record" turns a broken resolver into a passing
# apex check, and a SERVFAIL read as "no CAA record" turns it into a passing
# certificate-issuance policy check. There were three copies of the parser.

# Prints the DNS status word (NOERROR, NXDOMAIN, SERVFAIL, ...) from a dig
# response supplied on stdin, or nothing if the response carries no header.
dns_response_status() {
  awk '
    /^;; ->>HEADER<<-/ {
      for (i = 1; i <= NF; i++) {
        if ($i == "status:") {
          status = $(i + 1)
          sub(/,$/, "", status)
          print status
          exit
        }
      }
    }
  '
}
