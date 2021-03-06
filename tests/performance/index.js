/**
 * Copyright 2017–2018, LaborX PTY
 * Licensed under the AGPL Version 3 license.
 * @author Egor Zuev <zyev.egor@gmail.com>
 */

const config = require('../../config'),
  models = require('../../models'),
  spawn = require('child_process').spawn,
  expect = require('chai').expect,
  Promise = require('bluebird'),
  _ = require('lodash'),
  SyncCacheService = require('../../services/syncCacheService'),
  BlockWatchingService = require('../../services/blockWatchingService'),
  providerService = require('../../services/providerService'),
  sender = require('../utils/sender');

module.exports = (ctx) => {

  before(async () => {
    await models.blockModel.remove({});
    await models.txModel.remove({});
    await models.accountModel.remove({});
    global.gc();
  });

  it('validate sync cache service performance', async () => {
    const instance = await providerService.get();
    let blockNumber = await instance.getHeight();
    const addBlocksCount = 50 - blockNumber;

    if (addBlocksCount > 0)
      for (let i = 0; i < addBlocksCount; i++)
        await sender.sendTransaction(ctx.accounts, 0.00001);

    blockNumber = await instance.getHeight();
    const memUsage = process.memoryUsage().heapUsed / 1024 / 1024;
    const syncCacheService = new SyncCacheService();
    syncCacheService.doJob([[blockNumber - 50, blockNumber]]);
    await new Promise(res => syncCacheService.once('end', res));
    global.gc();
    await Promise.delay(5000);
    const memUsage2 = process.memoryUsage().heapUsed / 1024 / 1024;

    expect(memUsage2 - memUsage).to.be.below(3);
  });

  it('validate block watching service performance', async () => {
    const instance = await providerService.get();
    let blockNumber = await instance.getHeight();
    const addBlocksCount = 50 - blockNumber;

    if (addBlocksCount > 0)
      for (let i = 0; i < addBlocksCount; i++)
        await sender.sendTransaction(ctx.accounts, 0.00001);


    const memUsage = process.memoryUsage().heapUsed / 1024 / 1024;

    const blockWatchingService = new BlockWatchingService(blockNumber);
    await blockWatchingService.startSync();
    await Promise.delay(20000);
    await blockWatchingService.stopSync();
    global.gc();
    await Promise.delay(60000);
    const memUsage2 = process.memoryUsage().heapUsed / 1024 / 1024;

    expect(memUsage2 - memUsage).to.be.below(3);
  });


  it('validate tx notification speed', async () => {
    ctx.blockProcessorPid = spawn('node', ['index.js'], {
      env: _.merge({PROVIDERS: ctx.providers.join(',')}, process.env),
      stdio: 'ignore'
    });
    await Promise.delay(10000);
    await new models.accountModel({address: ctx.accounts[0].address}).save();

    let tx;
    let start;
    let end;

    await Promise.all([
      (async () => {
        await ctx.amqp.channel.assertQueue(`app_${config.rabbit.serviceName}_test_performance.transaction`);
        await ctx.amqp.channel.bindQueue(`app_${config.rabbit.serviceName}_test_performance.transaction`, 'events', `${config.rabbit.serviceName}_transaction.${ctx.accounts[0].address}`);
        await new Promise(res =>
          ctx.amqp.channel.consume(`app_${config.rabbit.serviceName}_test_performance.transaction`, async data => {

            if (!data)
              return;

            const message = JSON.parse(data.content.toString());

            if (tx && message.hash !== tx.transactionHash.data)
              return;

            end = Date.now();
            await ctx.amqp.channel.deleteQueue(`app_${config.rabbit.serviceName}_test_performance.transaction`);
            res();

          }, {noAck: true, autoDelete: true})
        );
      })(),
      (async () => {

        tx = await sender.sendTransaction(ctx.accounts, 0.00001);
        start = Date.now();
      })()
    ]);

    expect(end - start).to.be.below(2000);
    await Promise.delay(15000);
    ctx.blockProcessorPid.kill();
  });


  it('unconfirmed txs performance', async () => {
    const instance = await providerService.get();

    let blockNumber = await instance.getHeight();
    const blockWatchingService = new BlockWatchingService(blockNumber);

    await models.txModel.remove({blockNumber: {$gte: blockNumber - 50}});
    let txCount = await models.txModel.count();

    let blocks = [];
    for (let index = blockNumber - 50; index < blockNumber; index++)
      blocks.push(index);

    let txs = await Promise.mapSeries(blocks, async block => await instance.getBlockByNumber(block));
    txs = _.chain(txs).map(txs => txs.transactions).flattenDeep().value();

    const memUsage = process.memoryUsage().heapUsed / 1024 / 1024;

    for (let tx of txs)
      blockWatchingService.unconfirmedTxEvent(tx).catch(e => {
        throw new Error(e);
      });

    await new Promise(res => {
      let pinInterval = setInterval(async () => {
        let newTxCount = await models.txModel.count();

        if (newTxCount !== txCount + txs.length)
          return;

        clearInterval(pinInterval);
        res();
      }, 3000);
    });


    global.gc();
    await Promise.delay(60000);
    const memUsage2 = process.memoryUsage().heapUsed / 1024 / 1024;
    expect(memUsage2 - memUsage).to.be.below(3);
  });


};
