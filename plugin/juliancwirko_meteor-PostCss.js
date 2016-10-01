/* eslint-disable */
var appModulePath = Npm.require('app-module-path');
appModulePath.addPath(process.cwd() + '/node_modules/');
var Future = Npm.require('fibers/future');
var fs = Plugin.fs;
var path = Plugin.path;
var postCSS = Npm.require('postcss');
var sourcemap = Npm.require('source-map');

var PACKAGES_FILE = 'package.json';

var packageFile = path.resolve(process.cwd(), PACKAGES_FILE);

var loadJSONFile = function (filePath) {
    var content;
    try {
        content = fs.readFileSync(filePath);
        try {
            return JSON.parse(content);
        } catch (e) {
            console.log('Error: failed to parse ', filePath, ' as JSON');
            return {};
        }
    } catch (e) {
        return false;
    }
};

var postcssConfigPlugins;
var postcssConfigParser;
var postcssConfigExcludedPackages;

var jsonContent = loadJSONFile(packageFile);

if (typeof jsonContent === 'object') {
    postcssConfigPlugins = jsonContent.postcss && jsonContent.postcss.plugins;
    postcssConfigParser = jsonContent.postcss && jsonContent.postcss.parser;
    postcssConfigExcludedPackages = jsonContent.postcss && jsonContent.postcss.excludedPackages;
}

var getPostCSSPlugins = function () {
    var plugins = [];
    if (postcssConfigPlugins) {
        Object.keys(postcssConfigPlugins).forEach(function (pluginName) {
            var postCSSPlugin = Npm.require(pluginName);
            if (postCSSPlugin && postCSSPlugin.name === 'creator' && postCSSPlugin().postcssPlugin) {
                plugins.push(postCSSPlugin(postcssConfigPlugins ? postcssConfigPlugins[pluginName] : {}));
            }
        });
    }
    return plugins;
};

var getPostCSSParser = function () {
    var parser = null;
    if (postcssConfigParser) {
        parser = Npm.require(postcssConfigParser);
    }
    return parser;
};

var getExcludedPackages = function () {
    var excluded = null;
    if (postcssConfigExcludedPackages && postcssConfigExcludedPackages instanceof Array) {
        excluded = postcssConfigExcludedPackages;
    }
    return excluded;
};

var isNotInExcludedPackages = function (excludedPackages, pathInBundle) {
    var processedPackageName;
    var exclArr = [];
    if (excludedPackages && excludedPackages instanceof Array) {
        exclArr = excludedPackages.map(packageName => {
            processedPackageName = packageName && packageName.replace(':', '_');
            return pathInBundle && pathInBundle.indexOf('packages/' + processedPackageName) > -1;
        });
    }
    return exclArr.indexOf(true) === -1;
};

var isNotImport = function (inputFileUrl) {
    return !(/\.import\.css$/.test(inputFileUrl) ||
             /(?:^|\/)imports\//.test(inputFileUrl));
};

function CssToolsMinifier() {};

CssToolsMinifier.prototype.processFilesForBundle = function (files, options) {
    var mode = options.minifyMode;

    if (!files.length) return;

    var filesToMerge = [];

    files.forEach(function (file) {
        if (isNotImport(file._source.url)) {
            filesToMerge.push(file);
        }
    });

    var merged = mergeCss(filesToMerge);

    if (mode === 'development') {
        files[0].addStylesheet({
            data: merged.code,
            sourceMap: merged.sourceMap,
            path: 'merged-stylesheets.css'
        });
        return;
    }

    var minifiedFiles = CssTools.minifyCss(merged.code);

    if (files.length) {
        minifiedFiles.forEach(function (minified) {
            files[0].addStylesheet({
                data: minified
            });
        });
    }
};

// Lints CSS files and merges them into one file, fixing up source maps and
// pulling any @import directives up to the top since the CSS spec does not
// allow them to appear in the middle of a file.
var mergeCss = function (css) {
    // Filenames passed to AST manipulator mapped to their original files
    var originals = {};
    var excludedPackagesArr = getExcludedPackages();

    var cssAsts = css.map(function (file) {
        var filename = file.getPathInBundle();
        originals[filename] = file;

        var f = new Future;

        var css;
        var postres;
        var isFileForPostCSS;

        if (isNotInExcludedPackages(excludedPackagesArr, file.getPathInBundle())) {
            isFileForPostCSS = true;
        } else {
            isFileForPostCSS = false;
        }

        postCSS(isFileForPostCSS ? getPostCSSPlugins() : [])
            .process(file.getContentsAsString(), {
                from: process.cwd() + file._source.url,
                parser: getPostCSSParser()
            })
            .then(function (result) {
                result.warnings().forEach(function (warn) {
                    process.stderr.write(warn.toString());
                });
                f.return(result);
            })
            .catch(function (error) {
                var errMsg = error.message;
                if (error.name === 'CssSyntaxError') {
                    errMsg = error.message + '\n\n' + 'Css Syntax Error.' + '\n\n' + error.message + error.showSourceCode()
                }
                error.message = errMsg;
                f.return(error);
            });

        try {
            var parseOptions = {
                source: filename,
                position: true
            };

            postres = f.wait();

            if (postres.name === 'CssSyntaxError') {
                throw postres;
            }

            css = postres.css;

            var ast = CssTools.parseCss(css, parseOptions);
            ast.filename = filename;
        } catch (e) {

            if (e.name === 'CssSyntaxError') {
                file.error({
                    message: e.message,
                    line: e.line,
                    column: e.column
                });
            } else if (e.reason) {
                file.error({
                    message: e.reason,
                    line: e.line,
                    column: e.column
                });
            } else {
                // Just in case it's not the normal error the library makes.
                file.error({
                    message: e.message
                });
            }

            return {
                type: "stylesheet",
                stylesheet: {
                    rules: []
                },
                filename: filename
            };
        }

        return ast;
    });

    var warnCb = function (filename, msg) {
        // XXX make this a buildmessage.warning call rather than a random log.
        //     this API would be like buildmessage.error, but wouldn't cause
        //     the build to fail.
        console.log(filename + ': warn: ' + msg);
    };

    var mergedCssAst = CssTools.mergeCssAsts(cssAsts, warnCb);

    // Overwrite the CSS files list with the new concatenated file
    var stringifiedCss = CssTools.stringifyCss(mergedCssAst, {
        sourcemap: true,
        // don't try to read the referenced sourcemaps from the input
        inputSourcemaps: false
    });

    if (!stringifiedCss.code) {
        return {
            code: ''
        };
    }

    // Add the contents of the input files to the source map of the new file
    stringifiedCss.map.sourcesContent =
        stringifiedCss.map.sources.map(function (filename) {
            return originals[filename].getContentsAsString();
        });

    // If any input files had source maps, apply them.
    // Ex.: less -> css source map should be composed with css -> css source map
    var newMap = sourcemap.SourceMapGenerator.fromSourceMap(
        new sourcemap.SourceMapConsumer(stringifiedCss.map));

    Object.keys(originals).forEach(function (name) {
        var file = originals[name];
        if (!file.getSourceMap())
            return;
        try {
            newMap.applySourceMap(
                new sourcemap.SourceMapConsumer(file.getSourceMap()), name);
        } catch (err) {
            // If we can't apply the source map, silently drop it.
            //
            // XXX This is here because there are some less files that
            // produce source maps that throw when consumed. We should
            // figure out exactly why and fix it, but this will do for now.
        }
    });

    return {
        code: stringifiedCss.code,
        sourceMap: newMap.toString()
    };
};

exports.isNotImport = isNotImport;
exports.mergeCss = mergeCss;
exports.minifyCss = CssTools.minifyCss;
exports.processFilesForBundle = CssToolsMinifier.prototype.processFilesForBundle;
