# Serves the web client (web/) as a Lilypad demo. Deploy it with:
#   lilypad setup lilypad --repo <this repo> --port 8080 --health /healthz --size tiny --env-file web.env
#   lilypad create lilypad
# where web.env holds LILYPAD_API_URL=<platform URL> (and optionally LILYPAD_DEMO_DOMAIN=<demo domain>),
# so the page knows the platform without asking. Leave them out and the page asks for the URL once.
# nginx-unprivileged runs as a non-root user and listens on 8080. Pulled from ECR Public to avoid
# Docker Hub's anonymous pull limits in CodeBuild.
FROM public.ecr.aws/nginx/nginx-unprivileged:stable-alpine

# Only LILYPAD_* variables are substituted into the nginx template, so nginx's own $host, $uri, ...
# stay intact even if the container has an env var of the same name.
ENV LILYPAD_API_URL="" \
    LILYPAD_DEMO_DOMAIN="" \
    NGINX_ENVSUBST_FILTER="^LILYPAD_"

COPY web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY web/index.html /usr/share/nginx/html/index.html
COPY web/assets/ /usr/share/nginx/html/assets/

EXPOSE 8080
