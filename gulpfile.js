var gulp = require('gulp'),
    browserify = require('browserify'),
    buffer = require('vinyl-buffer'),
    cache,
    concatCss = require('gulp-concat-css'),
    jscs,
    jshint,
    livereload,
    minifyCss = require('gulp-minify-css'),
    nodeunit,
    plumber,
    prefixer = require('gulp-autoprefixer'),
    remember,
    rename = require('gulp-rename'),
    rimraf,
    sass = require('gulp-sass'),
    source = require('vinyl-source-stream'),
    stylish,
    uglify = require('gulp-uglify'),
    watchify,

    production = process.env.NODE_ENV === 'production',

    path = {
        src: {
            all: 'src/**/*',
            js: [ 'src/**/*.js', 'exercises/**/*.js' ],
            client: {
                main: './src/client/js/main.js',
                scss: 'src/client/**/*.s[ac]ss',
                static: [
                    'src/client/resources/**/*',
                    'src/client/exercises/**/*',
                    'src/client/*.html'
                ]
            },
            server: [ 'src/server/**/*', 'src/server/**/.*/**/*' ]
        },
        tests: 'test/**/*.js',
        dist: {
            base: 'dist/',
            all: 'dist/**/*',
            client: 'dist/client/',
            server: 'dist/server/',
            serverMain: 'dist/server/main.js'
        }
    },

    watching;

if ( !production ) {
    cache = require('gulp-cached');
    jscs = require('gulp-jscs');
    jshint = require('gulp-jshint');
    livereload = require('gulp-livereload');
    nodeunit = require('gulp-nodeunit');
    plumber = require('gulp-plumber');
    remember = require('gulp-remember');
    rimraf = require('rimraf');
    stylish = require('jshint-stylish');
    watchify = require('watchify');
}

// *~ is generated by vim as temp file when saving atomically
function notilde( path ) {
    return [].concat( path, '!**/*~' );
}

gulp.task( 'build', [ 'sass', 'browserify', 'collectstatic', 'collectserver' ] );
gulp.task( 'default', [ 'checkstyle', 'test', 'watch', 'build' ] );

gulp.task( 'clean', function( cb ) {
    rimraf( path.dist.base, cb );
});

gulp.task( 'test', function() {
    gulp.src( path.tests )
        .pipe( plumber())
        .pipe( nodeunit({
            reporter: 'skip_passed'
        }) );
});

gulp.task( 'checkstyle', function() {
    var stream = gulp.src( [].concat( path.src.js, path.tests ) )

    if ( !production ) {
        stream = stream
            .pipe( plumber() )
            .pipe( cache('scripts') );
    }

    stream.pipe( jscs() )
        .pipe( jshint() )
        .pipe( jshint.reporter( stylish ) );
});

gulp.task( 'sass', function() {
    var stream = gulp.src( path.src.client.scss )

    if ( !production ) {
        stream = stream
            .pipe( plumber() )
            .pipe( cache('styles') )
    }

    stream = stream.pipe( sass() );

    if( !production ) {
        stream = stream.pipe( remember('styles') );
    }

    stream.pipe( minifyCss({ cache: true }) )
        .pipe( concatCss('bundle.css') )
        .pipe( prefixer('> 5%') )
        .pipe( gulp.dest( path.dist.client ) );
});

gulp.task( 'browserify', function() {
    var bundler = browserify({
        cache: {}, packageCache: {}, fullPaths: true,
        entries: path.src.client.main,
        debug: !production
    });

    var bundle = function() {
        var stream = bundler.bundle()
            .pipe( source('bundle.js') );

        if ( production ) {
            stream = stream
                .pipe( buffer() )
                .pipe( uglify() )
        }

        stream.pipe( gulp.dest( path.dist.client ) );

        return stream;
    };

    if ( watching ) {
        bundler = watchify( bundler );
        bundler.on( 'update', bundle );
    }

    return bundle();
});

gulp.task( 'collectstatic', function() {
    var stream = gulp.src( notilde( path.src.client.static ) );

    if( !production ) {
        stream = stream.pipe( cache('static') );
    }

    stream.pipe( gulp.dest( path.dist.client ) );
});

gulp.task( 'collectserver', function() {
    var stream = gulp.src( notilde( path.src.server ) )
                     .pipe( plumber() );

    if( !production ) {
        stream = stream.pipe( cache('server') );
    }

    stream.pipe( gulp.dest( path.dist.server ) );
});

gulp.task( 'watch', function() {
    livereload({ silent: true });
    watching = true;
    gulp.watch( notilde( [].concat( path.src.js, path.tests ) ), [ 'checkstyle', 'test' ] );
    gulp.watch( notilde( path.src.client.scss ), [ 'sass' ] );
    gulp.watch( notilde( path.src.client.static ), [ 'collectstatic' ] );
    gulp.watch( notilde( path.src.server ), [ 'collectserver' ] );
    gulp.watch( path.dist.all ).on( 'change', livereload.changed );
});
