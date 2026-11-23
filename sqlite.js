const { DatabaseSync } = require('node:sqlite');
module.exports = class Database extends DatabaseSync {
  prepare(sql) {
    const stmt = super.prepare(sql);
    const names = [...new Set(sql.match(/@[a-zA-Z_]\w*/g) || [])];
    function args(values) {
      if (names.length && values[0] && typeof values[0] === 'object') {
        return [Object.fromEntries(names.map(name => [name, values[0][name.slice(1)]])), ...values.slice(1)];
      }
      return values;
    }
    return Object.fromEntries(['run','get','all'].map(method => [method, (...values) => stmt[method](...args(values))]));
  }
  transaction(fn) {
    return (...args) => {
      this.exec('BEGIN IMMEDIATE');
      try {
        const result = fn(...args);
        this.exec('COMMIT');
        return result;
      } catch (err) {
        this.exec('ROLLBACK');
        throw err;
      }
    };
  }
};
