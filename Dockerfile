FROM nginx:1.27-alpine

WORKDIR /usr/share/nginx/html

RUN rm /usr/share/nginx/html/index.html

COPY index.html .
COPY style.css .
COPY app.js .
COPY viewer.js .
COPY lib/ ./lib/
COPY placeholder_thumbnail.png ./placeholder_thumbnail.png