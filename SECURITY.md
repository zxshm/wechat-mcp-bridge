# Security

Run this single-owner bridge only behind a trusted authenticated HTTPS
boundary. Restrict the Access policy to the intended owner and keep the state
directory and environment file private. The bridge checks the Access JWT in
addition to the outer access policy. Do not expose the loopback listener
directly to the internet.

Do not paste session tokens, authentication headers, QR codes, webhook
secrets, encrypted state, personal messages, or private domains in an issue.
For a suspected vulnerability, use a private security reporting channel if the
repository has one; otherwise contact the repository owner privately before
publishing details. This project does not execute received files.
