# Changelog

## v1.1

### Added

- Support for **CAKE multi-queue (cake_mq)** for multi-core hardware
- Optional **DSCP restore via conntrack (ctinfo)**
- Separate **UDP and TCP priority classification**
- Early **prerouting DSCP marking** for download traffic
- Conditional DSCP rule creation based on LuCI options

### Improved

- More reliable download classification for CAKE
- Cleaner nftables rule structure
- Better DSCP policy flexibility
- Improved SQM integration with hardware multi-queue NICs

### Changed

- Gaming traffic classification redesigned
- Priority UDP and TCP rules now configurable independently
- DSCP marking pipeline now uses prerouting + postrouting

### Fixed

- Improved IFB redirection behaviour
- Better cleanup of nftables rules on SQM stop