# L126: connect response application attribution

Measurement-only branch for a signed-in reload of a dashboard deep link.

The live census attributes 82 ms to connect, 51 ms to chat.startup, and 30 ms to
models.snapshot. Before changing production code, reproduce the owning synchronous
application paths with the synthetic Team-scale bench on quiet AWS c7a.4xlarge.

The standard mock handshake supplies presence and capabilities, but does not emit
a negotiated models.snapshot publication. First establish which hot paths the
bench actually reproduces. A failed reproduction is an attribution stop, not
performance evidence for a production change.

No production changes yet. This draft is not for merging.
