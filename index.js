"use strict";

const _ = require("lodash");
const Promise = require("bluebird");
const dns = require("native-dns-multisocket");
const donut = require("donut");

const { NAME_TO_QCLASS, NAME_TO_QTYPE } = dns.consts;
const lookupMap = { type: NAME_TO_QTYPE, class: NAME_TO_QCLASS };
const { A } = NAME_TO_QTYPE;
const { IN } = NAME_TO_QCLASS;

const reSuffix = suff => new RegExp(`${_.escapeRegExp(suff)}$`);

const normRec = rec =>
  _.mapValues(rec, (val, key) =>
    _.castArray(val).map(v => {
      if (!isNaN(v) || !lookupMap[key]) return v;
      const nVal = lookupMap[key][v.toUpperCase()];
      if (nVal === undefined) throw new Error(`Unknown ${key} ${v}`);
      return nVal;
    })
  );

const makeRec = rec =>
  _.mapValues(normRec(rec), (val, key) => {
    if (!_.isArray(val)) return val;
    if (val.length === 0) return;
    if (val.length === 1) return val[0];
    throw new Error(`Illegal multivalue for ${key}`);
  });

const matchValue = (v, like) =>
  (like instanceof RegExp && like.test(v)) || like === v;

const matchValues = (v, like) => like.some(l => matchValue(v, l));

const matchObject = (obj, like) =>
  Object.entries(like).every(([k, v]) => matchValues(obj[k], v));

const makeMatcher = pred => {
  if (typeof pred === "function") return pred;

  if (_.isRegExp(pred) || _.isString(pred))
    return makeMatcher({ class: 1, name: pred });

  if (_.isArray(pred)) {
    const preds = pred.map(makeMatcher);
    return (req, res) => preds.some(p => p(req, res));
  }

  const norm = normRec(pred);
  return (req, res) => req.question.some(q => matchObject(q, norm));
};

class DonutDNS extends donut.Donut {
  constructor(opt) {
    super(Object.assign({ upstream: [], timeout: 10000 }, opt || []));
  }

  hook(pred, ...middleware) {
    return super.hook(makeMatcher(pred), ...middleware);
  }

  mergeAnswer(resOut, ...resIn) {
    for (const ri of _.flatten(resIn))
      for (const k of ["answer", "authority", "additional"])
        if (ri[k]) (resOut[k] = resOut[k] || []).push(...ri[k]);
  }

  async lookup(question) {
    const { upstream, timeout } = this.opt;

    const lookup = (question, server) => {
      if (_.isArray(server))
        return Promise.any(server.map(s => lookup(question, s)));

      return new Promise((resolve, reject) => {
        const res = {};
        dns
          .Request({ question, server, timeout })
          .on("message", (err, msg) => {
            if (err) reject(err);
            this.mergeAnswer(res, msg);
          })
          .on("end", () => resolve(res))
          .send();
      });
    };

    return lookup(question, upstream);
  }

  async lookupInto(question, res) {
    this.mergeAnswer(res, await this.lookup(question));
  }

  async proxyRequest(req, res) {
    this.mergeAnswer(
      res,
      await Promise.map(req.question, this.lookup.bind(this))
    );
  }

  alias(fake, real) {
    const fm = reSuffix(fake);
    const rm = reSuffix(real);

    return this.hook(fm, async (req, res) => {
      // For some reason a for loop that just changes the name causes
      // ;; Question section mismatch: got plinth.pike/A/IN
      req.question = req.question.map(q => ({
        ...q,
        name: q.name.replace(fm, real)
      }));

      await this.proxyRequest(req, res);

      res.answer = res.answer.map(a => ({
        ...a,
        name: a.name.replace(rm, fake)
      }));

      res.send();
    });
  }

  listen(port) {
    const serve = (server, type) =>
      server
        .on("listening", () =>
          console.log(`${type} server listening on ${port}`)
        )
        .on("close", () => console.log(`${type} server closed`))
        .on("error", (err, buff, req, res) => console.error(err.stack))
        .on("socketError", (err, socket) => console.error(err))
        .on("request", this.handle.bind(this))
        .serve(port);

    serve(dns.createUDPServer(), "UDP");
    serve(dns.createTCPServer(), "TCP");
  }
}

module.exports = DonutDNS;
