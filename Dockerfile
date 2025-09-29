FROM php:8.2-apache

RUN apt-get update && \
    apt-get install -y libimage-exiftool-perl && \
    rm -rf /var/lib/apt/lists/*

# Active mod_rewrite si besoin
RUN a2enmod rewrite

# Créer les dossiers cibles pour Apache
WORKDIR /var/www/html

