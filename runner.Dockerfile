FROM rust:1.90-bookworm
RUN rustup target add wasm32v1-none && rustup component add rustfmt rust-analyzer rust-src
WORKDIR /opt/template
COPY runner-template/ ./
RUN cargo fetch && cargo fetch --target wasm32v1-none && chmod -R a+rX /usr/local/cargo/registry
COPY runner-compat/ /opt/compat/
RUN cargo fetch --locked --manifest-path /opt/compat/sdk22/Cargo.toml && cargo fetch --locked --manifest-path /opt/compat/bls/Cargo.toml && cargo fetch --locked --manifest-path /opt/compat/example-deps/Cargo.toml && chmod -R a+rX /usr/local/cargo/registry
COPY runner-entrypoint.sh /usr/local/bin/sorobuild-run
RUN chmod 755 /usr/local/bin/sorobuild-run
ENV CARGO_NET_OFFLINE=true
ENTRYPOINT ["/usr/local/bin/sorobuild-run"]
