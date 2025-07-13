FROM nginx:1.27-alpine

WORKDIR /usr/share/nginx/html

RUN rm /usr/share/nginx/html/index.html

COPY . .