FROM quay.io/keycloak/keycloak:26.7.0@sha256:0f198be292568439d700cdbfb893e69a6009bb43a94a06a945b1d3d506c76b13 AS builder

ENV KC_DB=postgres \
	KC_HEALTH_ENABLED=true \
	KC_HTTP_RELATIVE_PATH=/keycloak \
	KC_METRICS_ENABLED=true

RUN /opt/keycloak/bin/kc.sh build

FROM quay.io/keycloak/keycloak:26.7.0@sha256:0f198be292568439d700cdbfb893e69a6009bb43a94a06a945b1d3d506c76b13

COPY --from=builder /opt/keycloak/ /opt/keycloak/

USER 0

ADD --checksum=sha256:4b40a06396f239f8de2da57419adde6e94e5edc18a2171d471ea05eeed4e5c2d https://repo.maven.apache.org/maven2/com/fasterxml/jackson/core/jackson-core/2.21.4/jackson-core-2.21.4.jar /tmp/jars/jackson-core-2.21.4.jar
ADD --checksum=sha256:3888e9e69ab66fbacaacc9aea0e9ffbf15368288e4aca468b024dba11c09fbf9 https://repo.maven.apache.org/maven2/com/fasterxml/jackson/core/jackson-databind/2.21.4/jackson-databind-2.21.4.jar /tmp/jars/jackson-databind-2.21.4.jar
ADD --checksum=sha256:e36f5237c1267983e5b88dc2169f6b9d7e50eceec6dc1ca31018e3877e14af66 https://repo.maven.apache.org/maven2/com/microsoft/sqlserver/mssql-jdbc/13.4.0.jre11/mssql-jdbc-13.4.0.jre11.jar /tmp/jars/mssql-jdbc-13.4.0.jre11.jar
ADD --checksum=sha256:1957ef2deaffbc1fb98cebfd0f5b3109ecf19c994d7e5378598c20747ba8d68b https://repo.maven.apache.org/maven2/io/micrometer/micrometer-core/1.16.6/micrometer-core-1.16.6.jar /tmp/jars/micrometer-core-1.16.6.jar
ADD --checksum=sha256:c88f13fc41156fde5df918c7b240038dfbe97ac57576163f208630391789b5d5 https://repo.maven.apache.org/maven2/io/netty/netty-buffer/4.1.136.Final/netty-buffer-4.1.136.Final.jar /tmp/jars/netty-buffer-4.1.136.Final.jar
ADD --checksum=sha256:2de4fc13005c7740b46427a47ee04265a19779c147d53e583f441889b1148159 https://repo.maven.apache.org/maven2/io/netty/netty-codec/4.1.136.Final/netty-codec-4.1.136.Final.jar /tmp/jars/netty-codec-4.1.136.Final.jar
ADD --checksum=sha256:89bddc4ec42756c41a0195a50a1323a324836162b6712a843c3de5c29096c93b https://repo.maven.apache.org/maven2/io/netty/netty-codec-dns/4.1.136.Final/netty-codec-dns-4.1.136.Final.jar /tmp/jars/netty-codec-dns-4.1.136.Final.jar
ADD --checksum=sha256:841be7fc6f1c929ecc63c70a909e0df085b4e80e44680acf46708f0e93e68037 https://repo.maven.apache.org/maven2/io/netty/netty-codec-haproxy/4.1.136.Final/netty-codec-haproxy-4.1.136.Final.jar /tmp/jars/netty-codec-haproxy-4.1.136.Final.jar
ADD --checksum=sha256:ffd1e1b19a533bc6e47ef2cbc1290374ff4a7cb53a280defa3df392538214948 https://repo.maven.apache.org/maven2/io/netty/netty-codec-http/4.1.136.Final/netty-codec-http-4.1.136.Final.jar /tmp/jars/netty-codec-http-4.1.136.Final.jar
ADD --checksum=sha256:14f67ae095c056b062aa0ee2c7b01f6b78004cf3620a6e9061bcb637f079387a https://repo.maven.apache.org/maven2/io/netty/netty-codec-http2/4.1.136.Final/netty-codec-http2-4.1.136.Final.jar /tmp/jars/netty-codec-http2-4.1.136.Final.jar
ADD --checksum=sha256:341f47dbaac667a6e7e6cad4114218025f9755ced641bb0740fb69e34d29b421 https://repo.maven.apache.org/maven2/io/netty/netty-codec-socks/4.1.136.Final/netty-codec-socks-4.1.136.Final.jar /tmp/jars/netty-codec-socks-4.1.136.Final.jar
ADD --checksum=sha256:e2f73be7ec359b46583ad875521137000eff520bafd320e730846ec9974f3be6 https://repo.maven.apache.org/maven2/io/netty/netty-common/4.1.136.Final/netty-common-4.1.136.Final.jar /tmp/jars/netty-common-4.1.136.Final.jar
ADD --checksum=sha256:54bb1a59f46a3aefd117942e6acee09e555b756776bad731fc06159d89c2da28 https://repo.maven.apache.org/maven2/io/netty/netty-handler/4.1.136.Final/netty-handler-4.1.136.Final.jar /tmp/jars/netty-handler-4.1.136.Final.jar
ADD --checksum=sha256:47400551f0444dea33629ee0c52d4e30856b2ddf00b12adf1881902957e74cf2 https://repo.maven.apache.org/maven2/io/netty/netty-handler-proxy/4.1.136.Final/netty-handler-proxy-4.1.136.Final.jar /tmp/jars/netty-handler-proxy-4.1.136.Final.jar
ADD --checksum=sha256:e64972fec474f5b9bd086b738154d190a923e82c4923ac550aff4f5ea9e98600 https://repo.maven.apache.org/maven2/io/netty/netty-resolver/4.1.136.Final/netty-resolver-4.1.136.Final.jar /tmp/jars/netty-resolver-4.1.136.Final.jar
ADD --checksum=sha256:9c05a9b18b5d54fcc1569c48b93958019cf3dde5ae7011f8a46451ee05e7daff https://repo.maven.apache.org/maven2/io/netty/netty-resolver-dns/4.1.136.Final/netty-resolver-dns-4.1.136.Final.jar /tmp/jars/netty-resolver-dns-4.1.136.Final.jar
ADD --checksum=sha256:b92881ea925721ed42fee5122a42b8bce4b84da737dbc3ca2d84dfaca52c28b6 https://repo.maven.apache.org/maven2/io/netty/netty-transport/4.1.136.Final/netty-transport-4.1.136.Final.jar /tmp/jars/netty-transport-4.1.136.Final.jar
ADD --checksum=sha256:f6a0b631b98667f131daf4ca07a9cae1072d58e259dcbc0f8c6a053d843449c6 https://repo.maven.apache.org/maven2/io/netty/netty-transport-classes-epoll/4.1.136.Final/netty-transport-classes-epoll-4.1.136.Final.jar /tmp/jars/netty-transport-classes-epoll-4.1.136.Final.jar
ADD --checksum=sha256:7e014c9b13defd9d254d4e5a5edd8ab6dde17533e1152f99699a6b28b2967a8a https://repo.maven.apache.org/maven2/io/netty/netty-transport-native-unix-common/4.1.136.Final/netty-transport-native-unix-common-4.1.136.Final.jar /tmp/jars/netty-transport-native-unix-common-4.1.136.Final.jar
ADD --checksum=sha256:31fbf6f06b2217fb51d5100cee51b22625cc81640da0679b47914e54c1e6377c https://repo.maven.apache.org/maven2/org/postgresql/postgresql/42.7.12/postgresql-42.7.12.jar /tmp/jars/postgresql-42.7.12.jar

RUN cp /tmp/jars/jackson-core-2.21.4.jar /opt/keycloak/lib/lib/main/com.fasterxml.jackson.core.jackson-core-2.21.2.jar \
	&& cp /tmp/jars/jackson-databind-2.21.4.jar /opt/keycloak/lib/lib/main/com.fasterxml.jackson.core.jackson-databind-2.21.2.jar \
	&& cp /tmp/jars/mssql-jdbc-13.4.0.jre11.jar /opt/keycloak/lib/lib/main/com.microsoft.sqlserver.mssql-jdbc-13.2.1.jre11.jar \
	&& cp /tmp/jars/micrometer-core-1.16.6.jar /opt/keycloak/lib/lib/main/io.micrometer.micrometer-core-1.16.3.jar \
	&& cp /tmp/jars/netty-buffer-4.1.136.Final.jar /opt/keycloak/lib/lib/main/io.netty.netty-buffer-4.1.135.Final.jar \
	&& cp /tmp/jars/netty-codec-4.1.136.Final.jar /opt/keycloak/lib/lib/main/io.netty.netty-codec-4.1.135.Final.jar \
	&& cp /tmp/jars/netty-codec-dns-4.1.136.Final.jar /opt/keycloak/lib/lib/main/io.netty.netty-codec-dns-4.1.135.Final.jar \
	&& cp /tmp/jars/netty-codec-haproxy-4.1.136.Final.jar /opt/keycloak/lib/lib/main/io.netty.netty-codec-haproxy-4.1.135.Final.jar \
	&& cp /tmp/jars/netty-codec-http-4.1.136.Final.jar /opt/keycloak/lib/lib/main/io.netty.netty-codec-http-4.1.135.Final.jar \
	&& cp /tmp/jars/netty-codec-http2-4.1.136.Final.jar /opt/keycloak/lib/lib/main/io.netty.netty-codec-http2-4.1.135.Final.jar \
	&& cp /tmp/jars/netty-codec-socks-4.1.136.Final.jar /opt/keycloak/lib/lib/main/io.netty.netty-codec-socks-4.1.135.Final.jar \
	&& cp /tmp/jars/netty-common-4.1.136.Final.jar /opt/keycloak/lib/lib/main/io.netty.netty-common-4.1.135.Final.jar \
	&& cp /tmp/jars/netty-handler-4.1.136.Final.jar /opt/keycloak/lib/lib/main/io.netty.netty-handler-4.1.135.Final.jar \
	&& cp /tmp/jars/netty-handler-proxy-4.1.136.Final.jar /opt/keycloak/lib/lib/main/io.netty.netty-handler-proxy-4.1.135.Final.jar \
	&& cp /tmp/jars/netty-resolver-4.1.136.Final.jar /opt/keycloak/lib/lib/main/io.netty.netty-resolver-4.1.135.Final.jar \
	&& cp /tmp/jars/netty-resolver-dns-4.1.136.Final.jar /opt/keycloak/lib/lib/main/io.netty.netty-resolver-dns-4.1.135.Final.jar \
	&& cp /tmp/jars/netty-transport-4.1.136.Final.jar /opt/keycloak/lib/lib/main/io.netty.netty-transport-4.1.135.Final.jar \
	&& cp /tmp/jars/netty-transport-classes-epoll-4.1.136.Final.jar /opt/keycloak/lib/lib/main/io.netty.netty-transport-classes-epoll-4.1.135.Final.jar \
	&& cp /tmp/jars/netty-transport-native-unix-common-4.1.136.Final.jar /opt/keycloak/lib/lib/main/io.netty.netty-transport-native-unix-common-4.1.135.Final.jar \
	&& cp /tmp/jars/postgresql-42.7.12.jar /opt/keycloak/lib/lib/main/org.postgresql.postgresql-42.7.11.jar \
	&& rm -f /opt/keycloak/bin/kcadm.bat /opt/keycloak/bin/kcadm.sh \
		/opt/keycloak/bin/kcreg.bat /opt/keycloak/bin/kcreg.sh \
	&& rm -rf /opt/keycloak/bin/client \
	&& chmod 0644 /opt/keycloak/lib/lib/main/io.netty.*-4.1.135.Final.jar \
		/opt/keycloak/lib/lib/main/com.fasterxml.jackson.core.jackson-core-2.21.2.jar \
		/opt/keycloak/lib/lib/main/com.fasterxml.jackson.core.jackson-databind-2.21.2.jar \
		/opt/keycloak/lib/lib/main/com.microsoft.sqlserver.mssql-jdbc-13.2.1.jre11.jar \
		/opt/keycloak/lib/lib/main/io.micrometer.micrometer-core-1.16.3.jar \
		/opt/keycloak/lib/lib/main/org.postgresql.postgresql-42.7.11.jar \
	&& rm -rf /tmp/jars \
	&& mkdir -p /opt/keycloak/data/import \
	&& chown 1000:0 /opt/keycloak/data/import \
	&& chmod 0750 /opt/keycloak/data/import

COPY --chown=1000:0 --chmod=0440 careos-realm.json /opt/keycloak/data/import/careos-realm.json

USER 1000