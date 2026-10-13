# Controlled test fixtures

The PEM certificate and key are public, deliberately disposable test material generated for the loopback TLS suite. They identify `fixture.example` and `127.0.0.1`, expire in 2036 and must never be used in a deployment. Only the TLS child test trusts this certificate through its process-local `NODE_EXTRA_CA_CERTS`; production verification is always enabled. No real operator credentials are stored here.
