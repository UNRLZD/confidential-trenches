// Node's 250 ms per-address connect window cancelled slow IPv4 connects on a Mac (0.25 to 0.55 s, no IPv6 route; 1 of 6 fetches failed, 1 Nov 04:37Z); at 2000 ms 6 of 6 worked.
import net from "node:net";

net.setDefaultAutoSelectFamilyAttemptTimeout(2000);
