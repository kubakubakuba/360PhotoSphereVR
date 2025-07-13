FROM nginx:1.27-alpine

RUN apk update && apk add openssl

RUN mkdir -p /etc/nginx/ssl
RUN openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout /etc/nginx/ssl/localhost.key \
    -out /etc/nginx/ssl/localhost.crt \
    -subj "/C=US/ST=Local/L=Local/O=Local/CN=localhost"

WORKDIR /usr/share/nginx/html
RUN rm /usr/share/nginx/html/index.html

COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY index.html .
COPY style.css .
COPY app.js .
COPY viewer.js .
COPY lib/ ./lib/