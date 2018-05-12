/**
 * Copyright 2017–2018, LaborX PTY
 * Licensed under the AGPL Version 3 license.
 * @author Kirill Sergeev <cloudkserg11@gmail.com>
 */
const http = require('http'),
    httpProxy = require('http-proxy'),
    express = require('express'),
    config = require('../config'),
    bunyan = require('bunyan'),
    log = bunyan.createLogger({name: 'app.proxy'});
    amqp = require('amqplib');

// create a server
const provider = config.node.providers[2];

if (!process.argv[2] || !process.argv[3]) {
    log.error('not set argument 2 as port for proxy/server.js');
    process.exit(0);
}

const port = process.argv[2];
const portWs = process.argv[3];

var proxy = httpProxy.createProxyServer({ target: provider.http})
    .listen(port);


const sendMessage = async (message) => {
    const amqpInstance = await amqp.connect(config.rabbit.url);
    const channel = await amqpInstance.createChannel();  

    await channel.assertExchange('events', 'topic', {durable: false});
    channel.publish('events', `${config.rabbit.serviceName}_test.check`, new Buffer(message));
};


proxy.on('proxyReq', function (proxyReq, req) {
    sendMessage(port);
});


var proxyWs = httpProxy.createProxyServer({ target: provider.ws, ws: true })
    .listen(portWs);

proxy.on('proxyReq', function (proxyReq, req) {
    sendMessage(portWs);
});
