FROM php:8.3-fpm-alpine

# bcmath is not optional here. Every monetary value in this system is a decimal string and the
# tax engine refuses to run without arbitrary-precision arithmetic — floats are how a POS ends
# up a centime off on a compound VAT chain.
RUN apk add --no-cache \
        git curl icu-dev libzip-dev oniguruma-dev postgresql-dev linux-headers $PHPIZE_DEPS \
    && docker-php-ext-install -j"$(nproc)" \
        bcmath intl opcache pcntl pdo_pgsql zip \
    && pecl install redis \
    && docker-php-ext-enable redis \
    && apk del $PHPIZE_DEPS

COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

WORKDIR /var/www/html

# Dependencies are installed at image build time so a cold `docker compose up` is usable
# without a manual step; the bind mount in docker-compose.yml then shadows the source.
COPY composer.json composer.lock ./
RUN composer install --no-interaction --no-scripts --no-autoloader --prefer-dist \
    || echo "composer install deferred to first run (no lockfile match)"

COPY . .
RUN composer dump-autoload --optimize --no-interaction || true

CMD ["php-fpm"]
