require("require-dir")("./gulp");

var gulp = require("gulp");
gulp.task("default", gulp.series(["browserify", "browserifyWithDeps", "makeCss", "makeMainPage"]));
gulp.task("serve", gulp.series(["makeCss", "makeMainPage", "browserifyForDebug", "watch", "connect"]));
